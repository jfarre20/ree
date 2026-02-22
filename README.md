 lk# ree — SRT Compositor Dashboard

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

## Docker (recommended)

Works on **any architecture** — arm64 (Raspberry Pi 4/5), amd64, etc. Both the C compositor and the `better-sqlite3` native addon compile from source inside the build, so the image is always native to whatever machine runs `docker build`. No `--platform` flag needed.

### 1. Register a Twitch app

Go to [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) → **Register Your Application** and add:

```
http://<your-host>:3000/api/auth/callback/twitch
```

as an OAuth Redirect URL.

### 2. Configure environment

```bash
cp .env.example .env
# fill in TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, NEXTAUTH_SECRET, NEXTAUTH_URL
```

The path variables (`COMPOSITOR_BINARY`, `UPLOADS_DIR`, `DATA_DIR`) are pre-filled with the correct container paths — leave them as-is.

### 3. Build and run

```bash
docker compose build
docker compose up -d
docker compose logs -f
```

App is at `http://<host>:3000`. The SQLite database is created automatically on first start at `./data/reestreamer.db`.

### Updating

```bash
git pull
docker compose build
docker compose up -d
```

### Cross-compiling for a Pi from an x86 machine

```bash
docker buildx build --platform linux/arm64 -t ree:latest --load .
```

### Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 3000 | TCP | Web UI |
| 6000–6099 | UDP | SRT listener pool (one per active stream) |

SRT ports must be reachable from your encoder. Open them in your firewall/router.

### Volumes

| Host path | Container path | Purpose |
|-----------|----------------|---------|
| `./data/` | `/app/data` | SQLite database |
| `./uploads/` | `/app/uploads` | Uploaded background videos |
| `./compositor/background.mp4` | `/app/compositor/background.mp4` | Default background (read-only) |

---

## Bare-metal setup

### Prerequisites

- **Linux** (any architecture)
- **Node.js 22+** and **pnpm**
- **FFmpeg dev libraries** with SRT support:

```bash
sudo apt install build-essential pkg-config \
    libavformat-dev libavcodec-dev libavutil-dev \
    libswscale-dev libswresample-dev
```

Verify SRT support: `ffmpeg -protocols 2>/dev/null | grep srt`

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

## Hosting / Production

### 1. Build

```bash
cd apps/web
pnpm build
```

### 2. Update environment for production

In `apps/web/.env.local`:

```env
NEXTAUTH_URL=https://your-domain.com
```

Also add `https://your-domain.com/api/auth/callback/twitch` to your Twitch app's OAuth redirect URLs.

### 3. Daemonize with systemd

Create `/etc/systemd/system/ree.service`:

```ini
[Unit]
Description=ree compositor dashboard
After=network.target

[Service]
Type=simple
User=compositor
WorkingDirectory=/home/compositor/apps/web
ExecStart=/usr/bin/node .next/standalone/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000
EnvironmentFile=/home/compositor/apps/web/.env.local

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ree
sudo systemctl status ree
# Live logs:
sudo journalctl -u ree -f
```


### 4. Reverse proxy with Caddy (recommended)

Caddy handles HTTPS automatically via Let's Encrypt.

```bash
sudo apt install caddy
```

`/etc/caddy/Caddyfile`:

```
your-domain.com {
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl reload caddy
```

### 4. Reverse proxy with nginx (alternative)

```bash
sudo apt install nginx certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

`/etc/nginx/sites-available/ree`:

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ree /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 4. Reverse proxy with HAProxy (alternative)

HAProxy is a good choice if you're already using it for other services or need fine-grained TCP control.

```bash
sudo apt install haproxy certbot
# Obtain cert first (haproxy needs a combined PEM)
sudo certbot certonly --standalone -d your-domain.com
sudo cat /etc/letsencrypt/live/your-domain.com/fullchain.pem \
         /etc/letsencrypt/live/your-domain.com/privkey.pem \
         > /etc/haproxy/certs/your-domain.com.pem
```

`/etc/haproxy/haproxy.cfg` — append:

```
frontend ree_https
    bind *:443 ssl crt /etc/haproxy/certs/your-domain.com.pem
    bind *:80
    redirect scheme https if !{ ssl_fc }
    default_backend ree_app

backend ree_app
    server ree 127.0.0.1:3000 check
```

```bash
sudo systemctl reload haproxy
```

> Renewing certs: add a deploy hook to regenerate the combined PEM and reload haproxy.

### 5. Reverse proxy with lighttpd (alternative)

lighttpd is lightweight and well-suited for low-resource machines like a Raspberry Pi.

```bash
sudo apt install lighttpd
```

Enable the required modules:

```bash
sudo lighttpd-enable-mod proxy
sudo lighttpd-enable-mod setenv
```

Create `/etc/lighttpd/conf-enabled/90-ree.conf`:

```lighttpd
$HTTP["host"] == "your-domain.com" {
    $SERVER["socket"] == ":443" {
        ssl.engine  = "enable"
        ssl.pemfile = "/etc/letsencrypt/live/your-domain.com/combined.pem"
        ssl.ca-file = "/etc/letsencrypt/live/your-domain.com/chain.pem"
    }

    proxy.server = ( "" => (
        ( "host" => "127.0.0.1", "port" => 3000 )
    ))

    proxy.header = (
        "map-urlpath"    => ( "/" => "/" ),
        "https-remap"   => "enable",
        "upgrade"        => "enable"
    )

    setenv.add-request-header = (
        "X-Forwarded-Proto" => "https",
        "X-Real-IP"         => "%{REMOTE_ADDR}e"
    )
}

# HTTP → HTTPS redirect
$HTTP["scheme"] == "http" {
    $HTTP["host"] == "your-domain.com" {
        url.redirect = ( "" => "https://your-domain.com${url.path}${qsa}" )
    }
}
```

> **Combined PEM for lighttpd:** lighttpd expects the cert + key in a single file:
> ```bash
> sudo cat /etc/letsencrypt/live/your-domain.com/fullchain.pem \
>          /etc/letsencrypt/live/your-domain.com/privkey.pem \
>          > /etc/letsencrypt/live/your-domain.com/combined.pem
> ```

> **WebSocket support:** The `"upgrade" => "enable"` line in `proxy.header` requires lighttpd **1.4.46+**. Check with `lighttpd -v`. Debian Bookworm ships 1.4.69+, so this should work out of the box.

```bash
sudo lighttpd -t -f /etc/lighttpd/lighttpd.conf   # test config
sudo systemctl restart lighttpd
```

### 6. Cloudflare (optional, recommended for production)

Cloudflare sits in front of your reverse proxy and gives you DDoS protection, free TLS, and a CDN — but requires a couple of settings to work correctly with ree.

#### DNS

| Name | Type | Content | Proxy |
|------|------|---------|-------|
| `ree.domain.com` | A | your server IP | **Proxied** (orange cloud) |
| `srt.domain.com` | A | your server IP | **DNS only** (grey cloud) |

**SRT must bypass Cloudflare.** Cloudflare's proxy is HTTP-only; it cannot forward UDP. Point your encoders at `srt.domain.com` (or the raw IP) instead of `ree.domain.com`.

#### SSL/TLS settings (Cloudflare dashboard → SSL/TLS)

| Setting | Value |
|---------|-------|
| Mode | **Full (strict)** |
| Always Use HTTPS | On |
| Minimum TLS Version | TLS 1.2 |

**Full (strict)** means Cloudflare validates your origin cert. Use either a free [Cloudflare Origin CA certificate](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/) (15-year validity, no renewal needed) or a Let's Encrypt cert on the origin.

#### Cloudflare Origin CA cert (easiest with Full strict)

In Cloudflare dashboard → SSL/TLS → Origin Server → **Create Certificate**. Download the cert and key, then:

**Caddy** — Caddy handles this automatically when proxied through Cloudflare with Full (strict); no changes needed if you already have a real cert.

**nginx:**
```nginx
ssl_certificate     /etc/ssl/cloudflare-origin.pem;
ssl_certificate_key /etc/ssl/cloudflare-origin.key;
```

**HAProxy** — combine into a single PEM:
```bash
cat cloudflare-origin.pem cloudflare-origin.key > /etc/haproxy/certs/ree.pem
sudo systemctl reload haproxy
```

#### Network settings (Cloudflare dashboard → Network)

| Setting | Value |
|---------|-------|
| WebSockets | **On** |
| gRPC | Off (not used) |

WebSockets must be on for tRPC subscriptions and hot-reload in dev.

#### Caching (Cloudflare dashboard → Caching)

| Setting | Value |
|---------|-------|
| Cache Level | Standard |
| Browser Cache TTL | Respect Existing Headers |

Next.js sets its own `Cache-Control` headers; Cloudflare will honour them. No page rules needed.

#### Lock origin to Cloudflare IPs only (optional but recommended)

Prevents anyone from hitting your server directly, bypassing Cloudflare.

```bash
# Allow only Cloudflare IP ranges + your own access
sudo ufw allow from 173.245.48.0/20 to any port 443 proto tcp
sudo ufw allow from 103.21.244.0/22 to any port 443 proto tcp
sudo ufw allow from 103.22.200.0/22 to any port 443 proto tcp
sudo ufw allow from 103.31.4.0/22 to any port 443 proto tcp
sudo ufw allow from 141.101.64.0/18 to any port 443 proto tcp
sudo ufw allow from 108.162.192.0/18 to any port 443 proto tcp
sudo ufw allow from 190.93.240.0/20 to any port 443 proto tcp
sudo ufw allow from 188.114.96.0/20 to any port 443 proto tcp
sudo ufw allow from 197.234.240.0/22 to any port 443 proto tcp
sudo ufw allow from 198.41.128.0/17 to any port 443 proto tcp
sudo ufw allow from 162.158.0.0/15 to any port 443 proto tcp
sudo ufw allow from 104.16.0.0/13 to any port 443 proto tcp
sudo ufw allow from 104.24.0.0/14 to any port 443 proto tcp
sudo ufw allow from 172.64.0.0/13 to any port 443 proto tcp
sudo ufw allow from 131.0.72.0/22 to any port 443 proto tcp
sudo ufw deny 443/tcp   # block everything else
```

> Keep the current Cloudflare IP list at [cloudflare.com/ips](https://www.cloudflare.com/ips/).

### 7. Open firewall ports

```bash
# Web traffic
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# SRT listener ports (UDP) — must be reachable from your encoder directly (not via Cloudflare)
sudo ufw allow 6000:6099/udp
```

If you're behind a router, forward the same UDP port range to your server.

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
apps/web/                    Next.js 15 (App Router)
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
| Frontend | Next.js 15, React 19, Tailwind CSS, shadcn/ui |
| API | tRPC v11, TanStack Query v5 |
| Auth | next-auth v4, Twitch OAuth (JWT sessions) |
| Database | SQLite + Drizzle ORM (better-sqlite3) |
| Runtime | Node.js 22 |
| Compositor | C (FFmpeg libav*, libsrt) |
