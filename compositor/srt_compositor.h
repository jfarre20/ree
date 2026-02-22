/*
 * srt_compositor.h — Type definitions and forward declarations
 *
 * Allows free reordering of functions in srt_compositor.c
 * without worrying about declaration order.
 */

#ifndef SRT_COMPOSITOR_H
#define SRT_COMPOSITOR_H

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

/* ================================================================== */
/*  Types                                                              */
/* ================================================================== */

/* Runtime configuration (loaded from JSON) */
typedef struct {
    char   srt_url[2048];
    char   bg_file[2048];
    char   stream_id[256];
    int    out_width;
    int    out_height;
    int    out_fps;
    int    video_bitrate;
    int    audio_bitrate;
    int    sample_rate;
    double bg_unmute_delay;  /* seconds */
    int    out_channels;
    int64_t srt_timeout_us;
    int64_t srt_retry_us;
} Config;

/* Decoder context for a media source (background or SRT) */
typedef struct {
    AVFormatContext *fmt_ctx;
    AVCodecContext  *video_dec_ctx;
    AVCodecContext  *audio_dec_ctx;
    int              video_stream_idx;
    int              audio_stream_idx;
    struct SwsContext *sws_ctx;
    SwrContext       *swr_ctx;
} SourceCtx;

/* Output encoder context */
typedef struct {
    AVFormatContext *fmt_ctx;
    AVCodecContext  *video_enc_ctx;
    AVCodecContext  *audio_enc_ctx;
    AVStream        *video_stream;
    AVStream        *audio_stream;
    int64_t          video_pts;
    int64_t          audio_pts;
} OutputCtx;

/* Shared SRT frame buffer (SRT thread → main thread) */
typedef struct {
    pthread_mutex_t  lock;
    uint8_t         *video_data[4];
    int              video_linesize[4];
    int              has_video;
    AVAudioFifo     *audio_fifo;
    int64_t          last_frame_time;
    int              connected;
} SrtShared;

/* Top-level application state */
typedef struct {
    SourceCtx   bg;
    OutputCtx   out;
    SrtShared   shared;
    pthread_t   srt_thread;
    AVFrame    *bg_frame;
    AVFrame    *out_frame;
    AVAudioFifo *bg_audio_fifo;
    AVAudioFifo *srt_local_fifo;
} AppState;

/* Audio source state machine */
enum AudioMode { AUDIO_SRT, AUDIO_GRACE, AUDIO_BG };

/* ================================================================== */
/*  Globals                                                            */
/* ================================================================== */

extern Config g_cfg;
extern volatile int g_running;

/* ================================================================== */
/*  Forward declarations                                               */
/* ================================================================== */

/* Config */
static int    load_config(const char *path);
static int    json_get_int(const char *json, const char *key, int def);
static double json_get_double(const char *json, const char *key, double def);
static void   json_get_str(const char *json, const char *key,
                            char *buf, size_t size, const char *def);

/* Logging */
static void   jlog(const char *event, const char *extra);

/* Signal */
static void   signal_handler(int sig);

/* Source management */
static void   close_source(SourceCtx *src);
static int    open_decoder(AVFormatContext *fmt, int idx, AVCodecContext **ctx);
static int    find_stream(AVFormatContext *fmt, enum AVMediaType type);
static SwrContext *make_resampler(AVCodecContext *dec);
static int    open_background(AppState *app);

/* SRT */
static int    srt_interrupt_cb(void *opaque);
static int    open_srt_source(SourceCtx *s, const char *url);
static void  *srt_thread_func(void *arg);

/* Output */
static int    open_output(AppState *app);

/* Encoding */
static int    encode_write_video(OutputCtx *o, AVFrame *frame);
static int    read_bg_frame(SourceCtx *s, AVFrame *scaled, AVAudioFifo *afifo);
static void   loop_bg(SourceCtx *s);
static void   encode_one_audio_frame(AppState *app, AVAudioFifo *fifo, int aframe_sz);

/* Main loop */
static void   main_loop(AppState *app);

#endif /* SRT_COMPOSITOR_H */
