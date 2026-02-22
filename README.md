# SRT Compositor

A small Linux executable that receives an SRT video feed, composites it over a looping background video (`spongewalk.mp4`), and outputs an encoded stream for Twitch.

## How It Works

```
SRT Feed ──┐
            ├──► [srt_compositor] ──► FLV (stdout) ──► ffmpeg ──► Twitch RTMP
Background ─┘     1280x720 30fps
(spongewalk.mp4)   H264 + AAC
```

- **SRT connected**: Shows the SRT feed video and audio, background is hidden/muted
- **SRT drops**: Immediately switches to background video and audio (spongewalk.mp4 loops)
- **SRT reconnects**: Automatically detects and switches back to SRT feed
- Reconnect attempts every 1 second when SRT is down
- 2 second timeout to detect SRT dropout

## Output Specs

| Setting | Value |
|---------|-------|
| Resolution | 1280x720 (16:9) |
| Frame Rate | 30 fps |
| Video Codec | H.264 (x264 ultrafast/zerolatency) |
| Video Bitrate | 4 Mbps |
| Audio Codec | AAC |
| Audio Bitrate | 128 kbps |
| Audio Sample Rate | 44100 Hz |
| B-frames | None (low latency) |
| GOP | 2 seconds |

## Prerequisites

### Install FFmpeg Development Libraries

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install build-essential pkg-config \
    libavformat-dev libavcodec-dev libavutil-dev \
    libswscale-dev libswresample-dev \
    ffmpeg
```

**Fedora:**
```bash
sudo dnf install gcc make pkg-config ffmpeg-devel ffmpeg
```

**Arch Linux:**
```bash
sudo pacman -S base-devel ffmpeg
```

> **Important**: Your FFmpeg must be built with SRT support (`--enable-libsrt`). 
> Check with: `ffmpeg -protocols 2>/dev/null | grep srt`

## Build

```bash
make
```

This produces the `srt_compositor` binary.

## Usage

### Quick Start with stream.sh

```bash
# Place your background video as spongewalk.mp4 in the same directory
chmod +x stream.sh

./stream.sh 'srt://hoth.srv.cactys.io:6000?mode=caller&latency=150' 'YOUR_TWITCH_STREAM_KEY'
```

### Manual Pipeline

```bash
# Compositor outputs FLV to stdout, pipe to ffmpeg for Twitch
./srt_compositor 'srt://hoth.srv.cactys.io:6000?mode=caller&latency=150' spongewalk.mp4 | \
    ffmpeg -f flv -i pipe:0 -c copy -f flv 'rtmp://live.twitch.tv/app/YOUR_KEY'
```

### Custom Background Video

```bash
./srt_compositor 'srt://host:6000?mode=caller&latency=150' my_background.mp4 | \
    ffmpeg -f flv -i pipe:0 -c copy -f flv 'rtmp://live.twitch.tv/app/YOUR_KEY'
```

### Test Without Twitch (save to file)

```bash
./srt_compositor 'srt://host:6000?mode=caller&latency=150' > output.flv
# Then play: ffplay output.flv
```

## Latency Optimizations

The compositor is designed for minimal latency:

- **Decoder**: `LOW_DELAY` flag, `FAST` flag, 2 threads
- **Encoder**: x264 `ultrafast` preset, `zerolatency` tune, no B-frames
- **SRT input**: `nobuffer` flag, small probe/analyze duration (0.5s)
- **Output**: Direct pipe to ffmpeg with `-c copy` (no re-encode on output side)
- **Frame pacing**: Tight 30fps loop with microsecond-precision sleep

## Log Output

All status messages go to stderr, so they don't interfere with the FLV pipe on stdout:

```
[compositor] Opening background: spongewalk.mp4
[bg] Opened: 1920x1080 video + audio
[compositor] Opening output encoder...
[out] FLV output ready: 1280x720 @30fps H264+AAC to stdout
[compositor] Starting main loop. SRT: srt://hoth.srv.cactys.io:6000?mode=caller&latency=150
[srt] Connecting to srt://hoth.srv.cactys.io:6000?mode=caller&latency=150 ...
[srt] Connected: 1920x1080 video + audio
[loop] >>> SRT ACTIVE - showing SRT, muting background
...
[srt] Read error, disconnecting
[loop] >>> SRT DROPPED - showing background video+audio
[bg] Looping...
[srt] Connecting to srt://... 
[srt] Connected: 1920x1080 video + audio
[loop] >>> SRT ACTIVE - showing SRT, muting background
```

## Signals

- `Ctrl+C` / `SIGINT`: Graceful shutdown
- `SIGPIPE`: Ignored (handles downstream pipe breaks)
