/*
 * srt_compositor - SRT to Twitch compositor with fallback video
 *
 * Takes SRT input, composites over a looping background video.
 * When SRT drops, background video/audio plays. When SRT resumes, it overlays.
 * Outputs encoded H264+AAC in FLV to stdout for piping to ffmpeg.
 *
 * Key design: SRT connect+read runs in a background thread so the main
 * encode loop NEVER blocks — Twitch always gets a steady 30 fps stream.
 *
 * v2: Runtime config via --config <json_file>. JSON status on stderr.
 */

#include "srt_compositor.h"

Config g_cfg;
volatile int g_running = 1;

/* ================================================================== */
/*  Minimal JSON config reader                                         */
/*  Handles flat JSON objects with string and number values.           */
/* ================================================================== */

static int json_get_int(const char *json, const char *key, int def) {
    char pattern[256];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(json, pattern);
    if (!p) return def;
    p = strchr(p + strlen(pattern), ':');
    if (!p) return def;
    while (*p == ':' || *p == ' ' || *p == '\t') p++;
    if (*p == '"') return def;  /* string value, not int */
    return (int)strtol(p, NULL, 10);
}

static double json_get_double(const char *json, const char *key, double def) {
    char pattern[256];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(json, pattern);
    if (!p) return def;
    p = strchr(p + strlen(pattern), ':');
    if (!p) return def;
    while (*p == ':' || *p == ' ' || *p == '\t') p++;
    if (*p == '"') return def;
    return strtod(p, NULL);
}

static void json_get_str(const char *json, const char *key,
                         char *buf, size_t size, const char *def) {
    char pattern[256];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(json, pattern);
    if (!p) { strncpy(buf, def, size - 1); buf[size-1] = '\0'; return; }
    p = strchr(p + strlen(pattern), ':');
    if (!p) { strncpy(buf, def, size - 1); buf[size-1] = '\0'; return; }
    while (*p == ':' || *p == ' ' || *p == '\t') p++;
    if (*p != '"') { strncpy(buf, def, size - 1); buf[size-1] = '\0'; return; }
    p++; /* skip opening quote */
    const char *end = strchr(p, '"');
    if (!end) { strncpy(buf, def, size - 1); buf[size-1] = '\0'; return; }
    size_t len = (size_t)(end - p);
    if (len >= size) len = size - 1;
    memcpy(buf, p, len);
    buf[len] = '\0';
}

static int load_config(const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) {
        fprintf(stderr, "{\"event\":\"error\",\"ts\":%ld,\"message\":\"Cannot open config: %s\"}\n",
                (long)time(NULL), path);
        return -1;
    }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    rewind(f);
    if (sz <= 0 || sz > 65536) { fclose(f); return -1; }
    char *buf = malloc(sz + 1);
    if (!buf) { fclose(f); return -1; }
    fread(buf, 1, sz, f);
    buf[sz] = '\0';
    fclose(f);

    json_get_str(buf, "srt_url",    g_cfg.srt_url,   sizeof(g_cfg.srt_url),   "");
    json_get_str(buf, "bg_file",    g_cfg.bg_file,   sizeof(g_cfg.bg_file),   "background.mp4");
    json_get_str(buf, "stream_id",  g_cfg.stream_id, sizeof(g_cfg.stream_id), "");

    g_cfg.out_width      = json_get_int(buf, "out_width",      1280);
    g_cfg.out_height     = json_get_int(buf, "out_height",     720);
    g_cfg.out_fps        = json_get_int(buf, "out_fps",        30);
    g_cfg.video_bitrate  = json_get_int(buf, "video_bitrate",  4000000);
    g_cfg.audio_bitrate  = json_get_int(buf, "audio_bitrate",  128000);
    g_cfg.sample_rate    = json_get_int(buf, "sample_rate",    48000);
    g_cfg.bg_unmute_delay= json_get_double(buf, "bg_unmute_delay", 5.0);
    g_cfg.out_channels   = 2;
    g_cfg.srt_timeout_us = 2000000;
    g_cfg.srt_retry_us   = 500000;

    free(buf);
    return 0;
}

/* ================================================================== */
/*  JSON status logging to stderr                                      */
/* ================================================================== */
static void jlog(const char *event, const char *extra) {
    long ts = (long)time(NULL);
    if (extra && extra[0]) {
        fprintf(stderr, "{\"event\":\"%s\",\"ts\":%ld,\"stream_id\":\"%s\",%s}\n",
                event, ts, g_cfg.stream_id, extra);
    } else {
        fprintf(stderr, "{\"event\":\"%s\",\"ts\":%ld,\"stream_id\":\"%s\"}\n",
                event, ts, g_cfg.stream_id);
    }
    fflush(stderr);
}

static void signal_handler(int sig) { (void)sig; g_running = 0; }

/* ================================================================== */
/*  close / open helpers                                               */
/* ================================================================== */

static void close_source(SourceCtx *src) {
    if (src->sws_ctx)       { sws_freeContext(src->sws_ctx); src->sws_ctx = NULL; }
    if (src->swr_ctx)       { swr_free(&src->swr_ctx); }
    if (src->video_dec_ctx) { avcodec_free_context(&src->video_dec_ctx); }
    if (src->audio_dec_ctx) { avcodec_free_context(&src->audio_dec_ctx); }
    if (src->fmt_ctx)       { avformat_close_input(&src->fmt_ctx); }
    src->video_stream_idx = -1;
    src->audio_stream_idx = -1;
}

static int open_decoder(AVFormatContext *fmt, int idx, AVCodecContext **ctx) {
    AVStream *st = fmt->streams[idx];
    const AVCodec *codec = avcodec_find_decoder(st->codecpar->codec_id);
    if (!codec) return -1;
    *ctx = avcodec_alloc_context3(codec);
    if (!*ctx) return AVERROR(ENOMEM);
    int ret = avcodec_parameters_to_context(*ctx, st->codecpar);
    if (ret < 0) return ret;
    (*ctx)->thread_count = 2;
    (*ctx)->flags  |= AV_CODEC_FLAG_LOW_DELAY;
    (*ctx)->flags2 |= AV_CODEC_FLAG2_FAST;
    return avcodec_open2(*ctx, codec, NULL);
}

static int find_stream(AVFormatContext *fmt, enum AVMediaType type) {
    for (unsigned i = 0; i < fmt->nb_streams; i++)
        if (fmt->streams[i]->codecpar->codec_type == type)
            return (int)i;
    return -1;
}

static SwrContext *make_resampler(AVCodecContext *dec) {
    SwrContext *swr = swr_alloc_set_opts(NULL,
        AV_CH_LAYOUT_STEREO, AV_SAMPLE_FMT_FLTP, g_cfg.sample_rate,
        dec->channel_layout ? dec->channel_layout : AV_CH_LAYOUT_STEREO,
        dec->sample_fmt, dec->sample_rate, 0, NULL);
    if (swr && swr_init(swr) < 0) { swr_free(&swr); return NULL; }
    return swr;
}

static int open_background(AppState *app) {
    SourceCtx *s = &app->bg;
    int ret;
    s->video_stream_idx = s->audio_stream_idx = -1;

    if ((ret = avformat_open_input(&s->fmt_ctx, g_cfg.bg_file, NULL, NULL)) < 0) return ret;
    if ((ret = avformat_find_stream_info(s->fmt_ctx, NULL)) < 0) return ret;

    s->video_stream_idx = find_stream(s->fmt_ctx, AVMEDIA_TYPE_VIDEO);
    s->audio_stream_idx = find_stream(s->fmt_ctx, AVMEDIA_TYPE_AUDIO);
    if (s->video_stream_idx < 0) {
        jlog("error", "\"message\":\"No video in background file\"");
        return -1;
    }

    if ((ret = open_decoder(s->fmt_ctx, s->video_stream_idx, &s->video_dec_ctx)) < 0) return ret;
    s->sws_ctx = sws_getContext(s->video_dec_ctx->width, s->video_dec_ctx->height,
        s->video_dec_ctx->pix_fmt, g_cfg.out_width, g_cfg.out_height, AV_PIX_FMT_YUV420P,
        SWS_BILINEAR, NULL, NULL, NULL);

    if (s->audio_stream_idx >= 0) {
        if (open_decoder(s->fmt_ctx, s->audio_stream_idx, &s->audio_dec_ctx) >= 0)
            s->swr_ctx = make_resampler(s->audio_dec_ctx);
    }
    jlog("bg_opened", NULL);
    return 0;
}

/* ================================================================== */
/*  SRT background thread                                              */
/* ================================================================== */
static int srt_interrupt_cb(void *opaque) { (void)opaque; return !g_running; }

static int open_srt_source(SourceCtx *s, const char *url) {
    int ret;
    s->video_stream_idx = s->audio_stream_idx = -1;

    s->fmt_ctx = avformat_alloc_context();
    if (!s->fmt_ctx) return AVERROR(ENOMEM);
    s->fmt_ctx->interrupt_callback.callback = srt_interrupt_cb;
    s->fmt_ctx->interrupt_callback.opaque = NULL;

    AVDictionary *opts = NULL;
    av_dict_set(&opts, "timeout",         "2000000", 0);
    av_dict_set(&opts, "rw_timeout",      "2000000", 0);
    av_dict_set(&opts, "analyzeduration", "500000",  0);
    av_dict_set(&opts, "probesize",       "500000",  0);
    av_dict_set(&opts, "fflags",          "nobuffer", 0);
    av_dict_set(&opts, "flags",           "low_delay", 0);

    ret = avformat_open_input(&s->fmt_ctx, url, NULL, &opts);
    av_dict_free(&opts);
    if (ret < 0) {
        char buf[256]; av_strerror(ret, buf, sizeof(buf));
        char extra[512];
        snprintf(extra, sizeof(extra), "\"message\":\"Cannot open SRT: %s\"", buf);
        jlog("srt_connect_failed", extra);
        s->fmt_ctx = NULL;
        return ret;
    }
    s->fmt_ctx->flags |= AVFMT_FLAG_NOBUFFER;
    if ((ret = avformat_find_stream_info(s->fmt_ctx, NULL)) < 0)
        { close_source(s); return ret; }

    s->video_stream_idx = find_stream(s->fmt_ctx, AVMEDIA_TYPE_VIDEO);
    s->audio_stream_idx = find_stream(s->fmt_ctx, AVMEDIA_TYPE_AUDIO);
    if (s->video_stream_idx < 0) { close_source(s); return -1; }

    if ((ret = open_decoder(s->fmt_ctx, s->video_stream_idx, &s->video_dec_ctx)) < 0)
        { close_source(s); return ret; }

    s->sws_ctx = sws_getContext(s->video_dec_ctx->width, s->video_dec_ctx->height,
        s->video_dec_ctx->pix_fmt, g_cfg.out_width, g_cfg.out_height, AV_PIX_FMT_YUV420P,
        SWS_BILINEAR, NULL, NULL, NULL);

    if (s->audio_stream_idx >= 0) {
        if (open_decoder(s->fmt_ctx, s->audio_stream_idx, &s->audio_dec_ctx) >= 0)
            s->swr_ctx = make_resampler(s->audio_dec_ctx);
    }

    char res[64];
    snprintf(res, sizeof(res), "\"resolution\":\"%dx%d\"",
             s->video_dec_ctx->width, s->video_dec_ctx->height);
    jlog("srt_connected", res);
    return 0;
}

static void *srt_thread_func(void *arg) {
    AppState  *app = (AppState *)arg;
    SrtShared *sh  = &app->shared;
    SourceCtx  src;
    memset(&src, 0, sizeof(src));
    src.video_stream_idx = src.audio_stream_idx = -1;

    AVPacket *pkt = av_packet_alloc();
    AVFrame  *raw = av_frame_alloc();
    uint8_t  *tmp_data[4] = {0};
    int       tmp_linesize[4] = {0};
    av_image_alloc(tmp_data, tmp_linesize, g_cfg.out_width, g_cfg.out_height, AV_PIX_FMT_YUV420P, 1);

    while (g_running) {
        if (!src.fmt_ctx) {
            if (open_srt_source(&src, g_cfg.srt_url) < 0) {
                for (int w = 0; w < 10 && g_running; w++)
                    usleep((unsigned)(g_cfg.srt_retry_us / 10));
                continue;
            }
            pthread_mutex_lock(&sh->lock);
            sh->connected = 1;
            sh->last_frame_time = av_gettime_relative();
            sh->has_video = 0;
            av_audio_fifo_reset(sh->audio_fifo);
            pthread_mutex_unlock(&sh->lock);
        }

        int ret = av_read_frame(src.fmt_ctx, pkt);
        if (ret < 0) {
            jlog("srt_dropped", "\"reason\":\"read_error\"");
            close_source(&src);
            pthread_mutex_lock(&sh->lock);
            sh->connected = 0;
            sh->has_video = 0;
            pthread_mutex_unlock(&sh->lock);
            continue;
        }

        if (pkt->stream_index == src.video_stream_idx && src.video_dec_ctx) {
            ret = avcodec_send_packet(src.video_dec_ctx, pkt);
            if (ret >= 0) {
                ret = avcodec_receive_frame(src.video_dec_ctx, raw);
                if (ret >= 0 && src.sws_ctx) {
                    sws_scale(src.sws_ctx,
                        (const uint8_t *const *)raw->data, raw->linesize,
                        0, raw->height, tmp_data, tmp_linesize);
                    pthread_mutex_lock(&sh->lock);
                    av_image_copy(sh->video_data, sh->video_linesize,
                                  (const uint8_t **)tmp_data, tmp_linesize,
                                  AV_PIX_FMT_YUV420P, g_cfg.out_width, g_cfg.out_height);
                    sh->has_video = 1;
                    sh->last_frame_time = av_gettime_relative();
                    pthread_mutex_unlock(&sh->lock);
                }
            }
        } else if (pkt->stream_index == src.audio_stream_idx &&
                   src.audio_dec_ctx && src.swr_ctx) {
            ret = avcodec_send_packet(src.audio_dec_ctx, pkt);
            if (ret >= 0) {
                ret = avcodec_receive_frame(src.audio_dec_ctx, raw);
                if (ret >= 0) {
                    int out_samples = swr_get_out_samples(src.swr_ctx, raw->nb_samples);
                    if (out_samples > 0) {
                        uint8_t *obuf[2] = {0};
                        av_samples_alloc(obuf, NULL, g_cfg.out_channels, out_samples,
                                         AV_SAMPLE_FMT_FLTP, 0);
                        int conv = swr_convert(src.swr_ctx, obuf, out_samples,
                                    (const uint8_t **)raw->data, raw->nb_samples);
                        if (conv > 0) {
                            pthread_mutex_lock(&sh->lock);
                            av_audio_fifo_write(sh->audio_fifo, (void **)obuf, conv);
                            sh->last_frame_time = av_gettime_relative();
                            pthread_mutex_unlock(&sh->lock);
                        }
                        av_freep(&obuf[0]);
                    }
                }
            }
        }
        av_packet_unref(pkt);

        pthread_mutex_lock(&sh->lock);
        int64_t elapsed = av_gettime_relative() - sh->last_frame_time;
        pthread_mutex_unlock(&sh->lock);
        if (elapsed > g_cfg.srt_timeout_us) {
            jlog("srt_dropped", "\"reason\":\"timeout\"");
            close_source(&src);
            pthread_mutex_lock(&sh->lock);
            sh->connected = 0;
            sh->has_video = 0;
            pthread_mutex_unlock(&sh->lock);
        }
    }

    close_source(&src);
    av_freep(&tmp_data[0]);
    av_packet_free(&pkt);
    av_frame_free(&raw);
    return NULL;
}

/* ================================================================== */
/*  open_output — FLV to stdout                                        */
/* ================================================================== */
static int open_output(AppState *app) {
    OutputCtx *o = &app->out;
    int ret;

    if ((ret = avformat_alloc_output_context2(&o->fmt_ctx, NULL, "flv", "pipe:1")) < 0)
        return ret;

    const AVCodec *vc = avcodec_find_encoder(AV_CODEC_ID_H264);
    if (!vc) { jlog("error", "\"message\":\"No H264 encoder\""); return -1; }
    o->video_enc_ctx = avcodec_alloc_context3(vc);
    o->video_enc_ctx->width        = g_cfg.out_width;
    o->video_enc_ctx->height       = g_cfg.out_height;
    o->video_enc_ctx->time_base    = (AVRational){1, g_cfg.out_fps};
    o->video_enc_ctx->framerate    = (AVRational){g_cfg.out_fps, 1};
    o->video_enc_ctx->pix_fmt      = AV_PIX_FMT_YUV420P;
    o->video_enc_ctx->gop_size     = g_cfg.out_fps * 2;
    o->video_enc_ctx->max_b_frames = 0;
    o->video_enc_ctx->bit_rate     = g_cfg.video_bitrate;
    o->video_enc_ctx->thread_count = 4;
    av_opt_set(o->video_enc_ctx->priv_data, "preset",  "ultrafast",   0);
    av_opt_set(o->video_enc_ctx->priv_data, "tune",    "zerolatency", 0);
    av_opt_set(o->video_enc_ctx->priv_data, "profile", "main",        0);
    if (o->fmt_ctx->oformat->flags & AVFMT_GLOBALHEADER)
        o->video_enc_ctx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    if ((ret = avcodec_open2(o->video_enc_ctx, vc, NULL)) < 0) return ret;
    o->video_stream = avformat_new_stream(o->fmt_ctx, NULL);
    avcodec_parameters_from_context(o->video_stream->codecpar, o->video_enc_ctx);
    o->video_stream->time_base = o->video_enc_ctx->time_base;

    const AVCodec *ac = avcodec_find_encoder(AV_CODEC_ID_AAC);
    if (!ac) { jlog("error", "\"message\":\"No AAC encoder\""); return -1; }
    o->audio_enc_ctx = avcodec_alloc_context3(ac);
    o->audio_enc_ctx->sample_rate    = g_cfg.sample_rate;
    o->audio_enc_ctx->channel_layout = AV_CH_LAYOUT_STEREO;
    o->audio_enc_ctx->channels       = g_cfg.out_channels;
    o->audio_enc_ctx->sample_fmt     = AV_SAMPLE_FMT_FLTP;
    o->audio_enc_ctx->bit_rate       = g_cfg.audio_bitrate;
    o->audio_enc_ctx->time_base      = (AVRational){1, g_cfg.sample_rate};
    if (o->fmt_ctx->oformat->flags & AVFMT_GLOBALHEADER)
        o->audio_enc_ctx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    if ((ret = avcodec_open2(o->audio_enc_ctx, ac, NULL)) < 0) return ret;
    o->audio_stream = avformat_new_stream(o->fmt_ctx, NULL);
    avcodec_parameters_from_context(o->audio_stream->codecpar, o->audio_enc_ctx);
    o->audio_stream->time_base = o->audio_enc_ctx->time_base;

    if ((ret = avio_open(&o->fmt_ctx->pb, "pipe:1", AVIO_FLAG_WRITE)) < 0) return ret;
    if ((ret = avformat_write_header(o->fmt_ctx, NULL)) < 0) return ret;
    o->video_pts = o->audio_pts = 0;

    char extra[256];
    snprintf(extra, sizeof(extra),
             "\"resolution\":\"%dx%d\",\"fps\":%d,\"vbr\":%d,\"abr\":%d",
             g_cfg.out_width, g_cfg.out_height,
             g_cfg.out_fps, g_cfg.video_bitrate, g_cfg.audio_bitrate);
    jlog("output_ready", extra);
    return 0;
}

/* ================================================================== */
/*  Encode helpers                                                     */
/* ================================================================== */
static int encode_write_video(OutputCtx *o, AVFrame *frame) {
    AVPacket *pkt = av_packet_alloc();
    frame->pts = o->video_pts++;
    frame->pict_type = AV_PICTURE_TYPE_NONE;
    int ret = avcodec_send_frame(o->video_enc_ctx, frame);
    while (ret >= 0) {
        ret = avcodec_receive_packet(o->video_enc_ctx, pkt);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) break;
        if (ret < 0) break;
        pkt->stream_index = o->video_stream->index;
        av_packet_rescale_ts(pkt, o->video_enc_ctx->time_base, o->video_stream->time_base);
        av_interleaved_write_frame(o->fmt_ctx, pkt);
    }
    av_packet_free(&pkt);
    return 0;
}

static int read_bg_frame(SourceCtx *s, AVFrame *scaled, AVAudioFifo *afifo) {
    AVPacket *pkt = av_packet_alloc();
    AVFrame  *raw = av_frame_alloc();
    int result = 0;
    int ret = av_read_frame(s->fmt_ctx, pkt);
    if (ret < 0) { av_packet_free(&pkt); av_frame_free(&raw); return ret; }

    if (pkt->stream_index == s->video_stream_idx && s->video_dec_ctx) {
        if (avcodec_send_packet(s->video_dec_ctx, pkt) >= 0 &&
            avcodec_receive_frame(s->video_dec_ctx, raw) >= 0) {
            scaled->format = AV_PIX_FMT_YUV420P;
            scaled->width = g_cfg.out_width;
            scaled->height = g_cfg.out_height;
            av_frame_get_buffer(scaled, 0);
            av_frame_make_writable(scaled);
            sws_scale(s->sws_ctx, (const uint8_t *const *)raw->data,
                      raw->linesize, 0, raw->height, scaled->data, scaled->linesize);
            result = 1;
        }
    } else if (pkt->stream_index == s->audio_stream_idx &&
               s->audio_dec_ctx && s->swr_ctx) {
        if (avcodec_send_packet(s->audio_dec_ctx, pkt) >= 0 &&
            avcodec_receive_frame(s->audio_dec_ctx, raw) >= 0) {
            int out_n = swr_get_out_samples(s->swr_ctx, raw->nb_samples);
            if (out_n > 0) {
                uint8_t *ob[2] = {0};
                av_samples_alloc(ob, NULL, g_cfg.out_channels, out_n, AV_SAMPLE_FMT_FLTP, 0);
                int c = swr_convert(s->swr_ctx, ob, out_n,
                                    (const uint8_t **)raw->data, raw->nb_samples);
                if (c > 0) av_audio_fifo_write(afifo, (void **)ob, c);
                av_freep(&ob[0]);
            }
            result = 2;
        }
    }
    av_frame_free(&raw);
    av_packet_free(&pkt);
    return result;
}

static void loop_bg(SourceCtx *s) {
    avio_seek(s->fmt_ctx->pb, 0, SEEK_SET);
    avformat_seek_file(s->fmt_ctx, -1, INT64_MIN, 0, INT64_MAX, 0);
    avcodec_flush_buffers(s->video_dec_ctx);
    if (s->audio_dec_ctx) avcodec_flush_buffers(s->audio_dec_ctx);
}

static void encode_one_audio_frame(AppState *app, AVAudioFifo *fifo, int aframe_sz) {
    AVFrame *f = av_frame_alloc();
    f->format = AV_SAMPLE_FMT_FLTP;
    f->nb_samples = aframe_sz;
    f->channel_layout = AV_CH_LAYOUT_STEREO;
    f->channels = g_cfg.out_channels;
    f->sample_rate = g_cfg.sample_rate;
    av_frame_get_buffer(f, 0);

    int avail = av_audio_fifo_size(fifo);
    if (avail >= aframe_sz) {
        av_audio_fifo_read(fifo, (void **)f->data, aframe_sz);
    } else {
        int plane_size = aframe_sz * av_get_bytes_per_sample(AV_SAMPLE_FMT_FLTP);
        for (int ch = 0; ch < g_cfg.out_channels; ch++)
            memset(f->data[ch], 0, plane_size);
        if (avail > 0)
            av_audio_fifo_read(fifo, (void **)f->data, avail);
    }

    f->pts = app->out.audio_pts;
    app->out.audio_pts += aframe_sz;

    AVPacket *pkt = av_packet_alloc();
    int ret = avcodec_send_frame(app->out.audio_enc_ctx, f);
    av_frame_free(&f);
    while (ret >= 0) {
        ret = avcodec_receive_packet(app->out.audio_enc_ctx, pkt);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) break;
        if (ret < 0) break;
        pkt->stream_index = app->out.audio_stream->index;
        av_packet_rescale_ts(pkt, app->out.audio_enc_ctx->time_base,
                             app->out.audio_stream->time_base);
        av_interleaved_write_frame(app->out.fmt_ctx, pkt);
    }
    av_packet_free(&pkt);
}

/* ================================================================== */
/*  Main encode loop                                                   */
/* ================================================================== */

static void main_loop(AppState *app) {
    SrtShared *sh = &app->shared;
    int64_t frame_dur = 1000000 / g_cfg.out_fps;
    int aframe_sz = app->out.audio_enc_ctx->frame_size;
    if (aframe_sz <= 0) aframe_sz = 1024;
    int64_t bg_unmute_us = (int64_t)(g_cfg.bg_unmute_delay * 1e6);

    int was_srt_video = 0;
    enum AudioMode audio_mode = AUDIO_BG;
    int64_t srt_drop_time = 0;
    int64_t stats_ticker = 0;

    jlog("running", NULL);

    while (g_running) {
        int64_t t0 = av_gettime_relative();

        /* ---- Always decode background ---- */
        int have_bg = 0;
        for (int i = 0; i < 5 && !have_bg; i++) {
            int r = read_bg_frame(&app->bg, app->bg_frame, app->bg_audio_fifo);
            if (r == 1) have_bg = 1;
            else if (r < 0) { loop_bg(&app->bg); }
        }

        /* ---- Check SRT shared buffer ---- */
        int use_srt_video = 0;
        pthread_mutex_lock(&sh->lock);
        if (sh->connected && sh->has_video) {
            av_frame_make_writable(app->out_frame);
            av_image_copy(app->out_frame->data, app->out_frame->linesize,
                          (const uint8_t **)sh->video_data, sh->video_linesize,
                          AV_PIX_FMT_YUV420P, g_cfg.out_width, g_cfg.out_height);
            use_srt_video = 1;
        }
        pthread_mutex_unlock(&sh->lock);

        /* ---- Audio mode state machine ---- */
        if (use_srt_video) {
            if (audio_mode != AUDIO_SRT) {
                jlog("srt_active", NULL);
                audio_mode = AUDIO_SRT;
                av_audio_fifo_reset(app->bg_audio_fifo);
            }
        } else {
            if (audio_mode == AUDIO_SRT) {
                srt_drop_time = av_gettime_relative();
                audio_mode = AUDIO_GRACE;
                jlog("srt_grace", NULL);
            }
            if (audio_mode == AUDIO_GRACE) {
                int64_t since_drop = av_gettime_relative() - srt_drop_time;
                if (since_drop > bg_unmute_us) {
                    audio_mode = AUDIO_BG;
                    jlog("bg_audio_on", NULL);
                }
            }
        }

        if (use_srt_video && !was_srt_video)
            jlog("video_srt", NULL);
        else if (!use_srt_video && was_srt_video)
            jlog("video_bg", NULL);
        was_srt_video = use_srt_video;

        /* ---- Video output ---- */
        if (use_srt_video) {
            encode_write_video(&app->out, app->out_frame);
        } else if (have_bg && app->bg_frame->data[0]) {
            av_frame_make_writable(app->out_frame);
            av_image_copy(app->out_frame->data, app->out_frame->linesize,
                          (const uint8_t **)app->bg_frame->data, app->bg_frame->linesize,
                          AV_PIX_FMT_YUV420P, g_cfg.out_width, g_cfg.out_height);
            encode_write_video(&app->out, app->out_frame);
        }

        /* ---- Audio ---- */
        {
            int srt_max_buf = (g_cfg.sample_rate * 300) / 1000;
            if (audio_mode == AUDIO_SRT) {
                pthread_mutex_lock(&sh->lock);
                int avail = av_audio_fifo_size(sh->audio_fifo);
                if (avail > 0) {
                    uint8_t *tbuf[8] = {0};
                    av_samples_alloc(tbuf, NULL, g_cfg.out_channels, avail, AV_SAMPLE_FMT_FLTP, 0);
                    av_audio_fifo_read(sh->audio_fifo, (void **)tbuf, avail);
                    av_audio_fifo_write(app->srt_local_fifo, (void **)tbuf, avail);
                    av_freep(&tbuf[0]);
                }
                pthread_mutex_unlock(&sh->lock);

                int local_sz = av_audio_fifo_size(app->srt_local_fifo);
                if (local_sz > srt_max_buf) {
                    int discard = local_sz - srt_max_buf;
                    uint8_t *junk[8] = {0};
                    av_samples_alloc(junk, NULL, g_cfg.out_channels, discard, AV_SAMPLE_FMT_FLTP, 0);
                    av_audio_fifo_read(app->srt_local_fifo, (void **)junk, discard);
                    av_freep(&junk[0]);
                }
            }

            int64_t target_audio = (app->out.video_pts * (int64_t)g_cfg.sample_rate) / g_cfg.out_fps;
            while (app->out.audio_pts < target_audio) {
                switch (audio_mode) {
                case AUDIO_SRT:
                    if (av_audio_fifo_size(app->srt_local_fifo) >= aframe_sz)
                        encode_one_audio_frame(app, app->srt_local_fifo, aframe_sz);
                    else goto audio_done;
                    break;
                case AUDIO_GRACE:
                    encode_one_audio_frame(app, app->srt_local_fifo, aframe_sz);
                    av_audio_fifo_reset(app->srt_local_fifo);
                    pthread_mutex_lock(&sh->lock);
                    av_audio_fifo_reset(sh->audio_fifo);
                    pthread_mutex_unlock(&sh->lock);
                    break;
                case AUDIO_BG:
                    encode_one_audio_frame(app, app->bg_audio_fifo, aframe_sz);
                    break;
                }
            }
            audio_done: ;
        }

        /* ---- Stats every ~30 frames (1 second) ---- */
        stats_ticker++;
        if (stats_ticker >= (int64_t)g_cfg.out_fps) {
            stats_ticker = 0;
            int srt_conn;
            pthread_mutex_lock(&sh->lock);
            srt_conn = sh->connected;
            pthread_mutex_unlock(&sh->lock);
            char extra[256];
            snprintf(extra, sizeof(extra),
                     "\"fps\":%d,\"srt_connected\":%s,\"audio_mode\":\"%s\"",
                     g_cfg.out_fps,
                     srt_conn ? "true" : "false",
                     audio_mode == AUDIO_SRT ? "srt" :
                     audio_mode == AUDIO_GRACE ? "grace" : "bg");
            jlog("stats", extra);
        }

        /* ---- Pace to target fps ---- */
        int64_t dt = av_gettime_relative() - t0;
        int64_t sl = frame_dur - dt;
        if (sl > 1000) usleep((unsigned)sl);
    }
    jlog("stopped", NULL);
}

/* ================================================================== */
/*  main                                                               */
/* ================================================================== */
int main(int argc, char **argv) {
    /* Set defaults */
    g_cfg.out_width       = 1280;
    g_cfg.out_height      = 720;
    g_cfg.out_fps         = 30;
    g_cfg.video_bitrate   = 4000000;
    g_cfg.audio_bitrate   = 128000;
    g_cfg.sample_rate     = 48000;
    g_cfg.bg_unmute_delay = 5.0;
    g_cfg.out_channels    = 2;
    g_cfg.srt_timeout_us  = 2000000;
    g_cfg.srt_retry_us    = 500000;
    strncpy(g_cfg.bg_file, "background.mp4", sizeof(g_cfg.bg_file) - 1);

    /* Parse arguments */
    const char *config_path = NULL;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--config") == 0 && i + 1 < argc) {
            config_path = argv[++i];
        } else if (argv[i][0] != '-' && !g_cfg.srt_url[0]) {
            /* Legacy positional: srt_url */
            strncpy(g_cfg.srt_url, argv[i], sizeof(g_cfg.srt_url) - 1);
        } else if (argv[i][0] != '-' && g_cfg.srt_url[0]) {
            /* Legacy positional: bg_file */
            strncpy(g_cfg.bg_file, argv[i], sizeof(g_cfg.bg_file) - 1);
        }
    }

    if (config_path) {
        if (load_config(config_path) < 0) return 1;
    }

    if (!g_cfg.srt_url[0]) {
        fprintf(stderr, "Usage: %s --config <config.json>\n", argv[0]);
        fprintf(stderr, "   or: %s <srt_url> [background.mp4]  (legacy)\n", argv[0]);
        return 1;
    }

    signal(SIGINT, signal_handler);
    signal(SIGPIPE, SIG_IGN);

    jlog("started", NULL);

    AppState app;
    memset(&app, 0, sizeof(app));

    pthread_mutex_init(&app.shared.lock, NULL);
    av_image_alloc(app.shared.video_data, app.shared.video_linesize,
                   g_cfg.out_width, g_cfg.out_height, AV_PIX_FMT_YUV420P, 1);
    app.shared.audio_fifo = av_audio_fifo_alloc(AV_SAMPLE_FMT_FLTP,
                                                 g_cfg.out_channels, g_cfg.sample_rate * 2);
    app.shared.connected = 0;
    app.shared.has_video = 0;

    app.bg_frame  = av_frame_alloc();
    app.out_frame = av_frame_alloc();
    app.out_frame->format = AV_PIX_FMT_YUV420P;
    app.out_frame->width  = g_cfg.out_width;
    app.out_frame->height = g_cfg.out_height;
    av_frame_get_buffer(app.out_frame, 0);
    app.bg_audio_fifo = av_audio_fifo_alloc(AV_SAMPLE_FMT_FLTP,
                                             g_cfg.out_channels, g_cfg.sample_rate * 2);
    app.srt_local_fifo = av_audio_fifo_alloc(AV_SAMPLE_FMT_FLTP,
                                              g_cfg.out_channels, g_cfg.sample_rate * 2);

    if (open_background(&app) < 0) {
        jlog("error", "\"message\":\"Background open failed\"");
        return 1;
    }
    if (open_output(&app) < 0) {
        jlog("error", "\"message\":\"Output open failed\"");
        return 1;
    }

    if (pthread_create(&app.srt_thread, NULL, srt_thread_func, &app) != 0) {
        jlog("error", "\"message\":\"Thread create failed\"");
        return 1;
    }

    main_loop(&app);

    g_running = 0;
    pthread_join(app.srt_thread, NULL);

    close_source(&app.bg);
    if (app.out.fmt_ctx) {
        av_write_trailer(app.out.fmt_ctx);
        avcodec_free_context(&app.out.video_enc_ctx);
        avcodec_free_context(&app.out.audio_enc_ctx);
        if (!(app.out.fmt_ctx->oformat->flags & AVFMT_NOFILE))
            avio_closep(&app.out.fmt_ctx->pb);
        avformat_free_context(app.out.fmt_ctx);
    }
    av_frame_free(&app.bg_frame);
    av_frame_free(&app.out_frame);
    av_audio_fifo_free(app.bg_audio_fifo);
    av_audio_fifo_free(app.srt_local_fifo);
    av_freep(&app.shared.video_data[0]);
    av_audio_fifo_free(app.shared.audio_fifo);
    pthread_mutex_destroy(&app.shared.lock);

    jlog("done", NULL);
    return 0;
}
