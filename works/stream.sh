#!/bin/bash
# stream.sh - Run srt_compositor and pipe to Twitch via ffmpeg
#
# Usage: ./stream.sh <srt_url> <twitch_stream_key> [background.mp4]
#
# Example:
#   ./stream.sh 'srt://hoth.srv.cactys.io:6000?mode=caller&latency=150' 'live_xxxxxxxxxxxx'
#   ./stream.sh 'srt://hoth.srv.cactys.io:6000?mode=caller&latency=150' 'live_xxxxxxxxxxxx' myvideo.mp4

set -e

SRT_URL="${1:?Usage: $0 <srt_url> <twitch_key> [background.mp4]}"
TWITCH_KEY="${2:?Usage: $0 <srt_url> <twitch_key> [background.mp4]}"
BG_VIDEO="${3:-spongewalk.mp4}"

TWITCH_INGEST="rtmp://live.twitch.tv/app/${TWITCH_KEY}"

# Check that srt_compositor exists
if [ ! -f "./srt_compositor" ]; then
    echo "Error: ./srt_compositor not found. Run 'make' first."
    exit 1
fi

# Check background video exists
if [ ! -f "${BG_VIDEO}" ]; then
    echo "Error: Background video '${BG_VIDEO}' not found."
    exit 1
fi

echo "============================================"
echo " SRT Compositor -> Twitch Stream"
echo "============================================"
echo " SRT Input:   ${SRT_URL}"
echo " Background:  ${BG_VIDEO}"
echo " Twitch:      rtmp://live.twitch.tv/app/****"
echo " Output:      1280x720 @ 30fps, H264+AAC"
echo "============================================"
echo ""
echo "Starting... (Ctrl+C to stop)"
echo ""

# Run the compositor, pipe FLV output to ffmpeg for Twitch
# The compositor outputs H264+AAC in FLV to stdout
# ffmpeg just copies the streams and sends to RTMP (no re-encode = low latency)
./srt_compositor "${SRT_URL}" "${BG_VIDEO}" 2>/dev/stderr | \
    ffmpeg -hide_banner -loglevel warning \
        -f flv -i pipe:0 \
        -c copy \
        -f flv \
        -flvflags no_duration_filesize \
        "${TWITCH_INGEST}"

echo ""
echo "Stream ended."
