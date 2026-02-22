# ──────────────────────────────────────────
# Stage 1: Build the C compositor binary
# ──────────────────────────────────────────
FROM debian:bookworm-slim AS builder-c

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc make pkg-config libc6-dev \
    libavformat-dev libavcodec-dev libavutil-dev \
    libswscale-dev libswresample-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY compositor/srt_compositor.c compositor/Makefile ./
RUN make

# ──────────────────────────────────────────
# Stage 2: Install Node deps + Next.js build
# ──────────────────────────────────────────
FROM node:22-bookworm-slim AS builder-node

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ pkg-config \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# Copy workspace manifest files first (maximises layer cache reuse)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/

# Install dependencies (compiles better-sqlite3 native addon here)
RUN pnpm install --frozen-lockfile

# Copy remaining source
COPY apps/web/ ./apps/web/

# Build Next.js standalone output
RUN pnpm --filter web build

# ──────────────────────────────────────────
# Stage 3: Minimal runtime image
# ──────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Compositor binary from stage 1
COPY --from=builder-c /build/srt_compositor /usr/local/bin/srt_compositor

WORKDIR /app

# Standalone server + traced node_modules (outputFileTracingRoot = monorepo root,
# so server.js lives at apps/web/server.js inside the standalone dir)
COPY --from=builder-node /app/apps/web/.next/standalone/ ./

# Static assets are not bundled into standalone
COPY --from=builder-node /app/apps/web/.next/static/ ./apps/web/.next/static/
COPY --from=builder-node /app/apps/web/public/ ./apps/web/public/

# Default background video (can be overridden via bind mount)
COPY compositor/background.mp4 /app/compositor/background.mp4

# Runtime data directories (mounted as volumes in production)
RUN mkdir -p /app/data /app/uploads

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000
# SRT listener ports (UDP) — published via docker-compose
EXPOSE 6000-6099/udp

ENTRYPOINT ["/entrypoint.sh"]
