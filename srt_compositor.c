/*
 * srt_compositor - SRT to Twitch compositor with fallback video
 *
 * Takes SRT input, composites over a looping background video.
 * When SRT drops, background video/audio plays. When SRT resumes, it overlays.
 * Outputs encoded H264+AAC in FLV to stdout for piping to ffmpeg.
 *
 * Key design: SRT connect+read runs in a background thread so the main
 * encode loop NEVER blocks — Twitch always gets a steady 30 fps stream.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include <time.h>
#include <pthread.h>

#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/avutil.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libavutil/time.h>
#include <libavutil/audio_fifo.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>

#define OUT_WIDTH       1280
#define OUT_HEIGHT      720
#define OUT_FPS         30
#define OUT_SAMPLE_RATE 48000
#define OUT_CHANNELS    2
#define SRT_TIMEOUT_US  2000000   /* 2 sec - detect SRT loss */
#define SRT_RETRY_US    500000    /* 0.5 sec between reconnect attempts */
#define BG_UNMUTE_DELAY_US 5000000 /* 5 sec grace before bg audio plays after SRT drop */

static volatile int g_running = 1;

static void signal_handler(int sig) { (void)sig; g_running = 0; }

/* ------------------------------------------------------------------ */
/*  Source context (decoder)                                           */
/* ------------------------------------------------------------------ */
typedef struct {
    AVFormatContext *fmt_ctx;
    AVCodecContext  *video_dec_ctx;
    AVCodecContext  *audio_dec_ctx;
    int              video_stream_idx;
    int              audio_stream_idx;
    struct SwsContext *sws_ctx;
    SwrContext       *swr_ctx;
} SourceCtx;

/* ------------------------------------------------------------------ */
/*  Output encoder                                                     */
/* ------------------------------------------------------------------ */
typedef struct {
    AVFormatContext *fmt_ctx;
    AVCodecContext  *video_enc_ctx;
    AVCodecContext  *audio_enc_ctx;
    AVStream        *video_stream;
    AVStream        *audio_stream;
    int64_t          video_pts;
    int64_t          audio_pts;
} OutputCtx;

/* ------------------------------------------------------------------ */
/*  Shared SRT frame buffer (written by SRT thread, read by main)      */
/* ------------------------------------------------------------------ */
typedef struct {
    pthread_mutex_t  lock;
    uint8_t         *video_data[4];
    int              video_linesize[4];
    int              has_video;          /* 1 = fresh frame available */
    AVAudioFifo     *audio_fifo;
    int64_t          last_frame_time;    /* last time we got ANY data */
    int              connected;          /* SRT thread sets this */
} SrtShared;

/* ------------------------------------------------------------------ */
/*  Application state                                                  */
/* ------------------------------------------------------------------ */
typedef struct {
    SourceCtx   bg;
    OutputCtx   out;
    char        srt_url[2048];

    /* Shared between threads */
    SrtShared   shared;
    pthread_t   srt_thread;

    /* Main-thread only */
    AVFrame    *bg_frame;
    AVFrame    *out_frame;
    AVAudioFifo *bg_audio_fifo;
    AVAudioFifo *srt_local_fifo;   /* persistent local copy of SRT audio */
} AppState;

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

/* find first stream of given type, return index or -1 */
static int find_stream(AVFormatContext *fmt, enum AVMediaType type) {
    for (unsigned i = 0; i < fmt->nb_streams; i++)
        if (fmt->streams[i]->codecpar->codec_type == type)
            return (int)i;
    return -1;
}

static SwrContext *make_resampler(AVCodecContext *dec) {
    SwrContext *swr = swr_alloc_set_opts(NULL,
        AV_CH_LAYOUT_STEREO, AV_SAMPLE_FMT_FLTP, OUT_SAMPLE_RATE,
        dec->channel_layout ? dec->channel_layout : AV_CH_LAYOUT_STEREO,
        dec->sample_fmt, dec->sample_rate, 0, NULL);
    if (swr && swr_init(swr) < 0) { swr_free(&swr); return NULL; }
    return swr;
}

/* ================================================================== */
/*  open_background — local file, main-thread only                     */
/* ================================================================== */
static int open_background(AppState *app, const char *filename) {
    SourceCtx *s = &app->bg;
    int ret;
    s->video_stream_idx = s->audio_stream_idx = -1;

    if ((ret = avformat_open_input(&s->fmt_ctx, filename, NULL, NULL)) < 0) return ret;
    if ((ret = avformat_find_stream_info(s->fmt_ctx, NULL)) < 0) return ret;

    s->video_stream_idx = find_stream(s->fmt_ctx, AVMEDIA_TYPE_VIDEO);
    s->audio_stream_idx = find_stream(s->fmt_ctx, AVMEDIA_TYPE_AUDIO);
    if (s->video_stream_idx < 0) { fprintf(stderr, "[bg] No video\n"); return -1; }

    if ((ret = open_decoder(s->fmt_ctx, s->video_stream_idx, &s->video_dec_ctx)) < 0) return ret;
    s->sws_ctx = sws_getContext(s->video_dec_ctx->width, s->video_dec_ctx->height,
        s->video_dec_ctx->pix_fmt, OUT_WIDTH, OUT_HEIGHT, AV_PIX_FMT_YUV420P,
        SWS_BILINEAR, NULL, NULL, NULL);

    if (s->audio_stream_idx >= 0) {
        if (open_decoder(s->fmt_ctx, s->audio_stream_idx, &s->audio_dec_ctx) >= 0)
            s->swr_ctx = make_resampler(s->audio_dec_ctx);
    }
    fprintf(stderr, "[bg] Opened %dx%d%s\n", s->video_dec_ctx->width,
            s->video_dec_ctx->height, s->audio_dec_ctx ? " +audio" : "");
    return 0;
}

/* ================================================================== */
/*  open_srt — called from SRT thread only                             */
/* ================================================================== */
/* Interrupt callback — makes blocking FFmpeg calls abort when g_running==0 */
static int srt_interrupt_cb(void *opaque) {
    (void)opaque;
    return !g_running;  /* return 1 to abort */
}

static int open_srt_source(SourceCtx *s, const char *url) {
    int ret;
    s->video_stream_idx = s->audio_stream_idx = -1;

    /* Pre-allocate format context so we can set interrupt callback BEFORE open */
    s->fmt_ctx = avformat_alloc_context();
    if (!s->fmt_ctx) return AVERROR(ENOMEM);
    s->fmt_ctx->interrupt_callback.callback = srt_interrupt_cb;
    s->fmt_ctx->interrupt_callback.opaque = NULL;

    AVDictionary *opts = NULL;
    av_dict_set(&opts, "timeout",          "2000000", 0);
    av_dict_set(&opts, "rw_timeout",       "2000000", 0);
    av_dict_set(&opts, "analyzeduration",  "500000",  0);
    av_dict_set(&opts, "probesize",        "500000",  0);
    av_dict_set(&opts, "fflags",           "nobuffer", 0);
    av_dict_set(&opts, "flags",            "low_delay", 0);

    fprintf(stderr, "[srt] Connecting to %s ...\n", url);
    ret = avformat_open_input(&s->fmt_ctx, url, NULL, &opts);
    av_dict_free(&opts);
    if (ret < 0) {
        char buf[256]; av_strerror(ret, buf, sizeof(buf));
        fprintf(stderr, "[srt] Cannot open: %s\n", buf);
        /* avformat_open_input frees fmt_ctx on failure */
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
        s->video_dec_ctx->pix_fmt, OUT_WIDTH, OUT_HEIGHT, AV_PIX_FMT_YUV420P,
        SWS_BILINEAR, NULL, NULL, NULL);

    if (s->audio_stream_idx >= 0) {
        if (open_decoder(s->fmt_ctx, s->audio_stream_idx, &s->audio_dec_ctx) >= 0)
            s->swr_ctx = make_resampler(s->audio_dec_ctx);
    }
    fprintf(stderr, "[srt] Connected %dx%d%s\n", s->video_dec_ctx->width,
            s->video_dec_ctx->height, s->audio_dec_ctx ? " +audio" : "");
    return 0;
}

/* ================================================================== */
/*  open_output — FLV to stdout                                        */
/* ================================================================== */
static int open_output(AppState *app) {
    OutputCtx *o = &app->out;
    int ret;

    if ((ret = avformat_alloc_output_context2(&o->fmt_ctx, NULL, "flv", "pipe:1")) < 0)
        return ret;

    /* Video: H264 ultrafast zerolatency */
    const AVCodec *vc = avcodec_find_encoder(AV_CODEC_ID_H264);
    if (!vc) { fprintf(stderr, "No H264 encoder\n"); return -1; }
    o->video_enc_ctx = avcodec_alloc_context3(vc);
    o->video_enc_ctx->width       = OUT_WIDTH;
    o->video_enc_ctx->height      = OUT_HEIGHT;
    o->video_enc_ctx->time_base   = (AVRational){1, OUT_FPS};
    o->video_enc_ctx->framerate   = (AVRational){OUT_FPS, 1};
    o->video_enc_ctx->pix_fmt     = AV_PIX_FMT_YUV420P;
    o->video_enc_ctx->gop_size    = OUT_FPS * 2;
    o->video_enc_ctx->max_b_frames = 0;
    o->video_enc_ctx->bit_rate    = 4000000;
    o->video_enc_ctx->thread_count = 4;
    av_opt_set(o->video_enc_ctx->priv_data, "preset",  "ultrafast",  0);
    av_opt_set(o->video_enc_ctx->priv_data, "tune",    "zerolatency", 0);
    av_opt_set(o->video_enc_ctx->priv_data, "profile", "main",        0);
    if (o->fmt_ctx->oformat->flags & AVFMT_GLOBALHEADER)
        o->video_enc_ctx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    if ((ret = avcodec_open2(o->video_enc_ctx, vc, NULL)) < 0) return ret;
    o->video_stream = avformat_new_stream(o->fmt_ctx, NULL);
    avcodec_parameters_from_context(o->video_stream->codecpar, o->video_enc_ctx);
    o->video_stream->time_base = o->video_enc_ctx->time_base;

    /* Audio: AAC */
    const AVCodec *ac = avcodec_find_encoder(AV_CODEC_ID_AAC);
    if (!ac) { fprintf(stderr, "No AAC encoder\n"); return -1; }
    o->audio_enc_ctx = avcodec_alloc_context3(ac);
    o->audio_enc_ctx->sample_rate    = OUT_SAMPLE_RATE;
    o->audio_enc_ctx->channel_layout = AV_CH_LAYOUT_STEREO;
    o->audio_enc_ctx->channels       = OUT_CHANNELS;
    o->audio_enc_ctx->sample_fmt     = AV_SAMPLE_FMT_FLTP;
    o->audio_enc_ctx->bit_rate       = 128000;
    o->audio_enc_ctx->time_base      = (AVRational){1, OUT_SAMPLE_RATE};
    if (o->fmt_ctx->oformat->flags & AVFMT_GLOBALHEADER)
        o->audio_enc_ctx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    if ((ret = avcodec_open2(o->audio_enc_ctx, ac, NULL)) < 0) return ret;
    o->audio_stream = avformat_new_stream(o->fmt_ctx, NULL);
    avcodec_parameters_from_context(o->audio_stream->codecpar, o->audio_enc_ctx);
    o->audio_stream->time_base = o->audio_enc_ctx->time_base;

    if ((ret = avio_open(&o->fmt_ctx->pb, "pipe:1", AVIO_FLAG_WRITE)) < 0) return ret;
    if ((ret = avformat_write_header(o->fmt_ctx, NULL)) < 0) return ret;
    o->video_pts = o->audio_pts = 0;
    fprintf(stderr, "[out] FLV %dx%d @%dfps H264+AAC → stdout\n", OUT_WIDTH, OUT_HEIGHT, OUT_FPS);
    return 0;
}

/* ================================================================== */
/*  SRT background thread                                              */
/*  Connects, reads, decodes, writes scaled frames into shared buf.    */
/*  The main loop NEVER calls any SRT/libav function — zero blocking.  */
/* ================================================================== */
static void *srt_thread_func(void *arg) {
    AppState  *app = (AppState *)arg;
    SrtShared *sh  = &app->shared;
    SourceCtx  src;
    memset(&src, 0, sizeof(src));
    src.video_stream_idx = src.audio_stream_idx = -1;

    AVPacket *pkt = av_packet_alloc();
    AVFrame  *raw = av_frame_alloc();
    /* Temporary scaled frame buffer (thread-local) */
    uint8_t  *tmp_data[4] = {0};
    int       tmp_linesize[4] = {0};
    av_image_alloc(tmp_data, tmp_linesize, OUT_WIDTH, OUT_HEIGHT, AV_PIX_FMT_YUV420P, 1);

    while (g_running) {
        /* ---------- (re)connect ---------- */
        if (!src.fmt_ctx) {
            if (open_srt_source(&src, app->srt_url) < 0) {
                /* Sleep in small increments so we can exit quickly */
                for (int w = 0; w < 10 && g_running; w++)
                    usleep(SRT_RETRY_US / 10);
                continue;
            }
            pthread_mutex_lock(&sh->lock);
            sh->connected = 1;
            sh->last_frame_time = av_gettime_relative();
            sh->has_video = 0;
            av_audio_fifo_reset(sh->audio_fifo);
            pthread_mutex_unlock(&sh->lock);
            fprintf(stderr, "[srt-thread] SRT connected!\n");
        }

        /* ---------- read one packet ---------- */
        int ret = av_read_frame(src.fmt_ctx, pkt);
        if (ret < 0) {
            fprintf(stderr, "[srt-thread] Read error, disconnecting\n");
            close_source(&src);
            pthread_mutex_lock(&sh->lock);
            sh->connected = 0;
            sh->has_video = 0;
            pthread_mutex_unlock(&sh->lock);
            continue;
        }

        /* ---------- decode video ---------- */
        if (pkt->stream_index == src.video_stream_idx && src.video_dec_ctx) {
            ret = avcodec_send_packet(src.video_dec_ctx, pkt);
            if (ret >= 0) {
                ret = avcodec_receive_frame(src.video_dec_ctx, raw);
                if (ret >= 0 && src.sws_ctx) {
                    sws_scale(src.sws_ctx,
                        (const uint8_t *const *)raw->data, raw->linesize,
                        0, raw->height, tmp_data, tmp_linesize);

                    /* Copy into shared buffer under lock */
                    pthread_mutex_lock(&sh->lock);
                    av_image_copy(sh->video_data, sh->video_linesize,
                                  (const uint8_t **)tmp_data, tmp_linesize,
                                  AV_PIX_FMT_YUV420P, OUT_WIDTH, OUT_HEIGHT);
                    sh->has_video = 1;
                    sh->last_frame_time = av_gettime_relative();
                    pthread_mutex_unlock(&sh->lock);
                }
            }
        }
        /* ---------- decode audio ---------- */
        else if (pkt->stream_index == src.audio_stream_idx &&
                 src.audio_dec_ctx && src.swr_ctx) {
            ret = avcodec_send_packet(src.audio_dec_ctx, pkt);
            if (ret >= 0) {
                ret = avcodec_receive_frame(src.audio_dec_ctx, raw);
                if (ret >= 0) {
                    int out_samples = swr_get_out_samples(src.swr_ctx, raw->nb_samples);
                    if (out_samples > 0) {
                        uint8_t *obuf[2] = {0};
                        av_samples_alloc(obuf, NULL, OUT_CHANNELS, out_samples,
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

        /* ---------- SRT timeout check ---------- */
        pthread_mutex_lock(&sh->lock);
        int64_t elapsed = av_gettime_relative() - sh->last_frame_time;
        pthread_mutex_unlock(&sh->lock);
        if (elapsed > SRT_TIMEOUT_US) {
            fprintf(stderr, "[srt-thread] Timeout, disconnecting\n");
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
/*  Encode helpers (main thread only)                                  */
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

/* ================================================================== */
/*  Background video reader (main thread, local file — fast, no block) */
/* ================================================================== */
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
            scaled->width = OUT_WIDTH; scaled->height = OUT_HEIGHT;
            av_frame_get_buffer(scaled, 0);
            av_frame_make_writable(scaled);
            sws_scale(s->sws_ctx, (const uint8_t *const *)raw->data,
                      raw->linesize, 0, raw->height,
                      scaled->data, scaled->linesize);
            result = 1;
        }
    } else if (pkt->stream_index == s->audio_stream_idx &&
               s->audio_dec_ctx && s->swr_ctx) {
        if (avcodec_send_packet(s->audio_dec_ctx, pkt) >= 0 &&
            avcodec_receive_frame(s->audio_dec_ctx, raw) >= 0) {
            int out_n = swr_get_out_samples(s->swr_ctx, raw->nb_samples);
            if (out_n > 0) {
                uint8_t *ob[2] = {0};
                av_samples_alloc(ob, NULL, OUT_CHANNELS, out_n, AV_SAMPLE_FMT_FLTP, 0);
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

/* ================================================================== */
/*  Main encode loop — NEVER blocks.  Always outputs at 30 fps.        */
/* ================================================================== */
/*
 * Audio source states:
 *   AUDIO_SRT    — SRT is active; play SRT audio (silence if FIFO briefly low)
 *   AUDIO_GRACE  — SRT just dropped; play silence for BG_UNMUTE_DELAY_US
 *   AUDIO_BG     — grace period over; play background video audio
 */
enum AudioMode { AUDIO_SRT, AUDIO_GRACE, AUDIO_BG };

/*
 * Encode exactly one audio frame from the given FIFO.
 * If FIFO doesn't have enough samples, pad with silence.
 */
static void encode_one_audio_frame(AppState *app, AVAudioFifo *fifo, int aframe_sz) {
    AVFrame *f = av_frame_alloc();
    f->format = AV_SAMPLE_FMT_FLTP;
    f->nb_samples = aframe_sz;
    f->channel_layout = AV_CH_LAYOUT_STEREO;
    f->channels = OUT_CHANNELS;
    f->sample_rate = OUT_SAMPLE_RATE;
    av_frame_get_buffer(f, 0);

    int avail = av_audio_fifo_size(fifo);
    if (avail >= aframe_sz) {
        av_audio_fifo_read(fifo, (void **)f->data, aframe_sz);
    } else {
        /* Read what we have, zero-fill the rest */
        int plane_size = aframe_sz * av_get_bytes_per_sample(AV_SAMPLE_FMT_FLTP);
        for (int ch = 0; ch < OUT_CHANNELS; ch++)
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

static void main_loop(AppState *app) {
    SrtShared *sh = &app->shared;
    int64_t frame_dur = 1000000 / OUT_FPS;
    int aframe_sz = app->out.audio_enc_ctx->frame_size;
    if (aframe_sz <= 0) aframe_sz = 1024;

    int was_srt_video = 0;
    enum AudioMode audio_mode = AUDIO_BG;
    int64_t srt_drop_time = 0;           /* when SRT video was last lost */

    fprintf(stderr, "[loop] Running @ %d fps, audio frame %d, bg unmute delay %.1fs\n",
            OUT_FPS, aframe_sz, BG_UNMUTE_DELAY_US / 1e6);

    while (g_running) {
        int64_t t0 = av_gettime_relative();

        /* ---- Always decode background ---- */
        int have_bg = 0;
        for (int i = 0; i < 5 && !have_bg; i++) {
            int r = read_bg_frame(&app->bg, app->bg_frame, app->bg_audio_fifo);
            if (r == 1) have_bg = 1;
            else if (r < 0) { loop_bg(&app->bg); }
        }

        /* ---- Check SRT shared buffer (quick lock) ---- */
        int use_srt_video = 0;
        pthread_mutex_lock(&sh->lock);
        if (sh->connected && sh->has_video) {
            av_frame_make_writable(app->out_frame);
            av_image_copy(app->out_frame->data, app->out_frame->linesize,
                          (const uint8_t **)sh->video_data, sh->video_linesize,
                          AV_PIX_FMT_YUV420P, OUT_WIDTH, OUT_HEIGHT);
            use_srt_video = 1;
        }
        pthread_mutex_unlock(&sh->lock);

        /* ---- Audio mode state machine ---- */
        if (use_srt_video) {
            /* SRT is live — always use SRT audio */
            if (audio_mode != AUDIO_SRT) {
                fprintf(stderr, "[loop] >>> SRT ACTIVE — SRT audio ON, bg muted\n");
                audio_mode = AUDIO_SRT;
                av_audio_fifo_reset(app->bg_audio_fifo);
            }
        } else {
            if (audio_mode == AUDIO_SRT) {
                /* SRT just dropped — enter grace period (silence) */
                srt_drop_time = av_gettime_relative();
                audio_mode = AUDIO_GRACE;
                fprintf(stderr, "[loop] >>> SRT DROPPED — silence grace period (%.0fs)\n",
                        BG_UNMUTE_DELAY_US / 1e6);
            }
            if (audio_mode == AUDIO_GRACE) {
                int64_t since_drop = av_gettime_relative() - srt_drop_time;
                if (since_drop > BG_UNMUTE_DELAY_US) {
                    audio_mode = AUDIO_BG;
                    fprintf(stderr, "[loop] >>> Grace period over — background audio ON\n");
                }
            }
        }

        /* ---- Video state change log ---- */
        if (use_srt_video && !was_srt_video)
            fprintf(stderr, "[loop] >>> SRT video ON\n");
        else if (!use_srt_video && was_srt_video)
            fprintf(stderr, "[loop] >>> SRT video OFF — showing background\n");
        was_srt_video = use_srt_video;

        /* ---- Video output ---- */
        if (use_srt_video) {
            encode_write_video(&app->out, app->out_frame);
        } else if (have_bg && app->bg_frame->data[0]) {
            av_frame_make_writable(app->out_frame);
            av_image_copy(app->out_frame->data, app->out_frame->linesize,
                          (const uint8_t **)app->bg_frame->data, app->bg_frame->linesize,
                          AV_PIX_FMT_YUV420P, OUT_WIDTH, OUT_HEIGHT);
            encode_write_video(&app->out, app->out_frame);
        }

        /*
         * ---- Audio: produce frames until audio PTS catches up to video PTS ----
         *
         * video_time = video_pts / OUT_FPS   (seconds)
         * audio_time = audio_pts / OUT_SAMPLE_RATE  (seconds)
         *
         * We encode audio frames until audio_time >= video_time.
         * This keeps audio and video perfectly synchronized regardless of
         * timing jitter, burst arrivals, or source rate mismatches.
         */
        {
            /*
             * SRT audio jitter buffer: allow ~150ms of buffered audio
             * (matches typical SRT latency). Only trim ONCE per video
             * frame so we don't keep discarding needed samples.
             */
            /* ~300ms max buffer: enough to absorb jitter, not so much that audio lags */
            int srt_max_buf = (OUT_SAMPLE_RATE * 300) / 1000;

            /*
             * Move ALL available SRT audio from shared FIFO to persistent local FIFO.
             * Don't trim the shared FIFO — just drain it completely each tick.
             * Leftover samples in local FIFO from previous ticks accumulate naturally.
             */
            if (audio_mode == AUDIO_SRT) {
                pthread_mutex_lock(&sh->lock);
                int avail = av_audio_fifo_size(sh->audio_fifo);
                if (avail > 0) {
                    uint8_t *tbuf[8] = {0};
                    av_samples_alloc(tbuf, NULL, OUT_CHANNELS, avail, AV_SAMPLE_FMT_FLTP, 0);
                    av_audio_fifo_read(sh->audio_fifo, (void **)tbuf, avail);
                    av_audio_fifo_write(app->srt_local_fifo, (void **)tbuf, avail);
                    av_freep(&tbuf[0]);
                }
                pthread_mutex_unlock(&sh->lock);

                /* Only trim local FIFO if it exceeds max buffer (prevents drift) */
                int local_sz = av_audio_fifo_size(app->srt_local_fifo);
                if (local_sz > srt_max_buf) {
                    int discard = local_sz - srt_max_buf;
                    uint8_t *junk[8] = {0};
                    av_samples_alloc(junk, NULL, OUT_CHANNELS, discard, AV_SAMPLE_FMT_FLTP, 0);
                    av_audio_fifo_read(app->srt_local_fifo, (void **)junk, discard);
                    av_freep(&junk[0]);
                }
            }

            /* Encode audio frames until audio PTS catches video PTS.
             * Only encode FULL frames — if FIFO < aframe_sz, wait for next tick. */
            int64_t target_audio = (app->out.video_pts * (int64_t)OUT_SAMPLE_RATE) / OUT_FPS;
            while (app->out.audio_pts < target_audio) {
                switch (audio_mode) {
                case AUDIO_SRT:
                    if (av_audio_fifo_size(app->srt_local_fifo) >= aframe_sz) {
                        /* Full frame available — encode clean audio */
                        encode_one_audio_frame(app, app->srt_local_fifo, aframe_sz);
                    } else {
                        /* Not enough samples yet — DON'T zero-pad!
                         * Break and let samples accumulate until next tick.
                         * PTS will catch up naturally when more audio arrives. */
                        goto audio_done;
                    }
                    break;
                case AUDIO_GRACE:
                    /* Pure silence */
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

        /* ---- Pace to 30 fps ---- */
        int64_t dt = av_gettime_relative() - t0;
        int64_t sl = frame_dur - dt;
        if (sl > 1000) usleep((unsigned)sl);
    }
    fprintf(stderr, "[loop] Exiting\n");
}

/* ================================================================== */
/*  main                                                               */
/* ================================================================== */
int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <srt_url> [background.mp4]\n", argv[0]);
        fprintf(stderr, "  Output is FLV on stdout — pipe to ffmpeg for Twitch.\n");
        return 1;
    }
    signal(SIGINT, signal_handler);
    signal(SIGPIPE, SIG_IGN);

    AppState app;
    memset(&app, 0, sizeof(app));
    strncpy(app.srt_url, argv[1], sizeof(app.srt_url) - 1);
    const char *bg_file = (argc >= 3) ? argv[2] : "spongewalk.mp4";

    /* Shared SRT buffer init */
    pthread_mutex_init(&app.shared.lock, NULL);
    av_image_alloc(app.shared.video_data, app.shared.video_linesize,
                   OUT_WIDTH, OUT_HEIGHT, AV_PIX_FMT_YUV420P, 1);
    app.shared.audio_fifo = av_audio_fifo_alloc(AV_SAMPLE_FMT_FLTP,
                                                 OUT_CHANNELS, OUT_SAMPLE_RATE * 2);
    app.shared.connected = 0;
    app.shared.has_video = 0;

    /* Main-thread frames */
    app.bg_frame  = av_frame_alloc();
    app.out_frame = av_frame_alloc();
    app.out_frame->format = AV_PIX_FMT_YUV420P;
    app.out_frame->width = OUT_WIDTH;
    app.out_frame->height = OUT_HEIGHT;
    av_frame_get_buffer(app.out_frame, 0);
    app.bg_audio_fifo = av_audio_fifo_alloc(AV_SAMPLE_FMT_FLTP,
                                             OUT_CHANNELS, OUT_SAMPLE_RATE * 2);
    app.srt_local_fifo = av_audio_fifo_alloc(AV_SAMPLE_FMT_FLTP,
                                              OUT_CHANNELS, OUT_SAMPLE_RATE * 2);

    fprintf(stderr, "[init] Background: %s\n", bg_file);
    if (open_background(&app, bg_file) < 0) { fprintf(stderr, "BG fail\n"); return 1; }

    fprintf(stderr, "[init] Output encoder...\n");
    if (open_output(&app) < 0) { fprintf(stderr, "Output fail\n"); return 1; }

    /* Start SRT thread */
    if (pthread_create(&app.srt_thread, NULL, srt_thread_func, &app) != 0) {
        fprintf(stderr, "Thread create failed\n"); return 1;
    }

    fprintf(stderr, "[init] Entering main loop. SRT=%s\n", app.srt_url);
    main_loop(&app);

    /* Shutdown */
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

    fprintf(stderr, "[done] Shutdown complete.\n");
    return 0;
}
