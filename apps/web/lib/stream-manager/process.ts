import { spawn, type ChildProcess } from "child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import path from "path";
import { parseCompositorLine, type CompositorEvent } from "./parser";

export interface StreamConfig {
  streamId: string;
  srtPort: number;
  srtLatency: number;
  srtPassphrase?: string;
  bgFile: string;
  outWidth: number;
  outHeight: number;
  outFps: number;
  videoBitrate: number;
  audioBitrate: number;
  sampleRate: number;
  bgAudioFadeDelay: number;
  reconnectTimeout: number; // seconds, 0 = never auto-stop
  twitchStreamKey: string;
  twitchIngestServer: string;
}

export interface StreamStatus {
  running: boolean;
  srtConnected: boolean;
  pid?: number;
  startedAt?: Date;
  lastEvent?: CompositorEvent;
  logs: string[];
}

const COMPOSITOR_BINARY =
  process.env.COMPOSITOR_BINARY ??
  path.join(process.cwd(), "../../compositor/srt_compositor");

const CONFIG_DIR = path.join(
  process.env.DATA_DIR ?? path.join(process.cwd(), "../../data"),
  "configs"
);

export class StreamProcess {
  readonly streamId: string;
  private compositor: ChildProcess | null = null;
  private ffmpeg: ChildProcess | null = null;
  private _status: StreamStatus;
  private configPath: string;
  private onStatusChange: (status: StreamStatus) => void;
  private reconnectTimeout = 0;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    streamId: string,
    onStatusChange: (status: StreamStatus) => void
  ) {
    this.streamId = streamId;
    this.configPath = path.join(CONFIG_DIR, `${streamId}.json`);
    this.onStatusChange = onStatusChange;
    this._status = {
      running: false,
      srtConnected: false,
      logs: [],
    };
  }

  get status(): StreamStatus {
    return { ...this._status, logs: [...this._status.logs] };
  }

  async start(config: StreamConfig): Promise<void> {
    if (this.compositor) throw new Error("Stream already running");

    mkdirSync(CONFIG_DIR, { recursive: true });

    // Write JSON config file for the compositor
    const compositorConfig = {
      stream_id: config.streamId,
      srt_url: buildSrtUrl(config),
      bg_file: config.bgFile,
      out_width: config.outWidth,
      out_height: config.outHeight,
      out_fps: config.outFps,
      video_bitrate: config.videoBitrate,
      audio_bitrate: config.audioBitrate,
      sample_rate: config.sampleRate,
      bg_unmute_delay: config.bgAudioFadeDelay,
    };
    writeFileSync(this.configPath, JSON.stringify(compositorConfig, null, 2));

    const rtmpUrl = `rtmp://${config.twitchIngestServer}/live/${config.twitchStreamKey}`;

    // Spawn compositor
    this.compositor = spawn(COMPOSITOR_BINARY, ["--config", this.configPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Spawn ffmpeg, reading from compositor's stdout
    this.ffmpeg = spawn(
      "ffmpeg",
      [
        "-re",
        "-f", "flv",
        "-i", "pipe:0",
        "-c", "copy",
        "-f", "flv",
        rtmpUrl,
      ],
      { stdio: ["pipe", "ignore", "pipe"] }
    );

    // Pipe compositor stdout → ffmpeg stdin
    this.compositor.stdout!.pipe(this.ffmpeg.stdin!);

    this.reconnectTimeout = config.reconnectTimeout;

    this._status = {
      running: true,
      srtConnected: false,
      pid: this.compositor.pid,
      startedAt: new Date(),
      logs: [],
    };
    this.onStatusChange(this.status);

    // Parse compositor stderr
    this.compositor.stderr!.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        this.appendLog(line);
        const event = parseCompositorLine(line);
        if (event) this.handleEvent(event);
      }
    });

    // ffmpeg stderr (just log it)
    this.ffmpeg.stderr!.on("data", (data: Buffer) => {
      // only keep last part to avoid noise
      const msg = data.toString().trim().split("\n").pop() ?? "";
      if (msg) this.appendLog(`[ffmpeg] ${msg}`);
    });

    this.compositor.on("exit", (code) => {
      this.appendLog(`[compositor] exited with code ${code}`);
      this.ffmpeg?.stdin?.end();
      this.cleanup();
    });

    this.ffmpeg.on("exit", (code) => {
      this.appendLog(`[ffmpeg] exited with code ${code}`);
      this.cleanup();
    });
  }

  stop(): void {
    if (!this.compositor) return;
    this.compositor.kill("SIGINT");
    // Give it 5s then force-kill
    setTimeout(() => {
      this.compositor?.kill("SIGKILL");
      this.ffmpeg?.kill("SIGKILL");
    }, 5000);
  }

  private handleEvent(event: CompositorEvent) {
    switch (event.event) {
      case "srt_connected":
        this._status.srtConnected = true;
        // Clear any pending disconnect timer
        if (this.disconnectTimer) {
          clearTimeout(this.disconnectTimer);
          this.disconnectTimer = null;
          this.appendLog(`[timeout] Reconnected — auto-stop timer cancelled`);
        }
        break;
      case "srt_dropped":
        this._status.srtConnected = false;
        // Start disconnect timer if configured
        if (this.reconnectTimeout > 0 && !this.disconnectTimer) {
          const mins = Math.round(this.reconnectTimeout / 60);
          this.appendLog(`[timeout] SRT disconnected — will auto-stop in ${mins > 0 ? mins + "m" : this.reconnectTimeout + "s"} if not reconnected`);
          this.disconnectTimer = setTimeout(() => {
            this.appendLog(`[timeout] Reconnect timeout reached (${mins > 0 ? mins + "m" : this.reconnectTimeout + "s"}) — stopping stream`);
            this.stop();
          }, this.reconnectTimeout * 1000);
        }
        break;
      case "stopped":
        this._status.running = false;
        this._status.srtConnected = false;
        break;
    }
    this._status.lastEvent = event;
    this.onStatusChange(this.status);
  }

  private appendLog(line: string) {
    this._status.logs.push(`[${new Date().toISOString()}] ${line}`);
    // Keep last 500 lines
    if (this._status.logs.length > 500) {
      this._status.logs = this._status.logs.slice(-500);
    }
  }

  private cleanup() {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    this.compositor = null;
    this.ffmpeg = null;
    this._status.running = false;
    this._status.srtConnected = false;
    this._status.pid = undefined;
    this.onStatusChange(this.status);
    try {
      unlinkSync(this.configPath);
    } catch {}
  }
}

function buildSrtUrl(config: StreamConfig): string {
  let url = `srt://0.0.0.0:${config.srtPort}?mode=listener&latency=${config.srtLatency}`;
  if (config.srtPassphrase) {
    url += `&passphrase=${encodeURIComponent(config.srtPassphrase)}`;
  }
  return url;
}
