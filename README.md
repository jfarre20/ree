# ree — SRT Compositor Dashboard

Self-hosted web dashboard that manages `srt_compositor` processes and pushes them to Twitch RTMP.

```
OBS/vMix ──► SRT ──► srt_compositor ──► RTMP ──► Twitch
                           │
                    background.mp4 (loops while SRT is down)
```

Sign in with Twitch → stream key is fetched automatically → configure and go live.

---

## How It Works

Each stream gets a dedicated **SRT listener port** (UDP). Point your encoder at `srt://<host>:<port>?mode=caller`. The compositor:

- Shows your SRT feed when connected
- Switches to a looping background MP4 when the SRT feed drops
- Switches back automatically on reconnect
- Pushes the result to Twitch via RTMP

The web dashboard lets you create/manage streams, upload background videos, configure encoding settings, and start/stop compositing — all without touching the command line.

---

## Prerequisites

- **Linux** (x86-64)
- **Node.js 22+** and **pnpm**
- **FFmpeg dev libraries** with SRT support:

```bash
sudo apt install build-essential pkg-config \
    libavformat-dev libavcodec-dev libavutil-dev \
    libswscale-dev libswresample-dev
```

Verify SRT support: `ffmpeg -protocols 2>/dev/null | grep srt`

---

## Setup

### 1. Build the compositor binary

```bash
cd compositor
gcc -Wall -Wextra -O2 -std=c11 -D_GNU_SOURCE \
  $(pkg-config --cflags libavformat libavcodec libavutil libswscale libswresample) \
  -o srt_compositor srt_compositor.c \
  $(pkg-config --libs libavformat libavcodec libavutil libswscale libswresample) \
  -lpthread -lm
```

### 2. Register a Twitch OAuth app

Go to [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) → **Register Your Application**:

| Field | Value |
|-------|-------|
| Name | anything |
| OAuth Redirect URLs | `http://localhost:3000/api/auth/callback/twitch` (dev) |
| Category | Broadcasting Suite |

Copy the **Client ID** and generate a **Client Secret**.

### 3. Configure environment

```bash
cp .env.example apps/web/.env.local
```

Edit `apps/web/.env.local`:

```env
TWITCH_CLIENT_ID=<your client id>
TWITCH_CLIENT_SECRET=<your client secret>
NEXTAUTH_SECRET=<run: openssl rand -base64 32>
NEXTAUTH_URL=http://localhost:3000

COMPOSITOR_BINARY=/absolute/path/to/compositor/srt_compositor
UPLOADS_DIR=/absolute/path/to/uploads
DATA_DIR=/absolute/path/to/data
```

### 4. Install dependencies

```bash
pnpm install
```

> `better-sqlite3` compiles a native addon — requires `build-essential` / `python3`.

---

## Running

### Development

```bash
./start-dev.sh
```

Open [http://localhost:3000](http://localhost:3000).

### Production

```bash
cd apps/web
pnpm build
pnpm start
```

---

## Local Testing with a Public URL

Twitch OAuth requires a publicly reachable callback URL — `localhost` won't work unless you expose it. Pick any of the options below.

### Option A — cloudflared (easiest, no account needed)

```bash
# Install (Debian/Ubuntu)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# Start a tunnel to port 3000
cloudflared tunnel --url http://localhost:3000
```

Cloudflared prints a random `https://*.trycloudflare.com` URL. Use that as your base.

### Option B — ngrok

```bash
# Install: https://ngrok.com/download
ngrok http 3000
```

Ngrok prints a `https://<random>.ngrok-free.app` URL.

### Option C — SSH reverse tunnel (if you have a VPS)

```bash
# On your local machine — forwards VPS port 3000 → your local 3000
ssh -R 3000:localhost:3000 user@your-vps-ip
```

Then either access via `http://your-vps-ip:3000` or put nginx in front for HTTPS.

---

### After you have a public URL

**1. Add the callback URL to your Twitch app** ([dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)):

```
https://<your-tunnel-url>/api/auth/callback/twitch
```

**2. Update `apps/web/.env.local`:**

```env
NEXTAUTH_URL=https://<your-tunnel-url>
```

**3. Restart the dev server** — `./start-dev.sh`

> Tip: cloudflared and ngrok give a new random URL each run. For a stable URL during development, use ngrok's paid plan, a reserved Cloudflare tunnel, or a VPS.

---

## First Sign-In

Sign in with Twitch OAuth. The app automatically:

1. Creates your user account
2. Fetches your Twitch stream key via the API (`channel:read:stream_key` scope)
3. Pre-populates stream key on all your streams

Re-signing in refreshes the stream key if Twitch ever rotates it.

---

## Architecture

```
apps/web/                    Next.js 14 (App Router)
├── app/                     Pages and API routes
├── components/              shadcn/ui components
└── lib/
    ├── auth.ts              next-auth v4, Twitch OAuth, JWT sessions
    ├── db/                  Drizzle ORM + SQLite (better-sqlite3)
    │   ├── schema.ts        users, sessions, streams, uploads
    │   └── index.ts         DB init + inline migrations
    ├── trpc/                tRPC v11 routers (streams, uploads)
    └── stream-manager/      Node.js process manager for compositor

compositor/
└── srt_compositor.c         C binary — SRT → background compositor → RTMP
```

### Compositor v2 flags

```
srt_compositor --config <config.json>
```

Config JSON fields: `srt_url`, `bg_file`, `stream_id`, `out_width`, `out_height`, `out_fps`, `video_bitrate`, `audio_bitrate`, `sample_rate`, `bg_unmute_delay`.

Events emitted on stderr as JSON: `started`, `bg_opened`, `srt_connected`, `srt_dropped`, `srt_active`, `output_ready`, `running`, `stats`, `stopped`, `done`, `error`.

### SRT port pool

Default: ports 6000–6099 (100 concurrent streams). Configure via `SRT_PORT_MIN` / `SRT_PORT_MAX`.

### Database

SQLite at `$DATA_DIR/reestreamer.db`. Schema is created/migrated automatically on startup — no migration CLI needed.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14, React 18, Tailwind CSS, shadcn/ui |
| API | tRPC v11, TanStack Query v5 |
| Auth | next-auth v4, Twitch OAuth (JWT sessions) |
| Database | SQLite + Drizzle ORM (better-sqlite3) |
| Runtime | Node.js 22 |
| Compositor | C (FFmpeg libav*, libsrt) |
