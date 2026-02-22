/**
 * StreamManager — singleton that owns all active compositor processes.
 * Imported by tRPC server routes to start/stop/monitor streams.
 *
 * Lives entirely on the server (Node.js) — never imported by client code.
 */

import { StreamProcess, type StreamConfig, type StreamStatus } from "./process";
import { db } from "@/lib/db";
import { streams } from "@/lib/db/schema";
import { eq, lt, and, ne } from "drizzle-orm";

class StreamManager {
  private processes = new Map<string, StreamProcess>();
  private portMin: number;
  private portMax: number;
  private initialized = false;
  private usedPorts = new Set<number>();

  constructor() {
    this.portMin = parseInt(process.env.SRT_PORT_MIN ?? "6000", 10);
    this.portMax = parseInt(process.env.SRT_PORT_MAX ?? "6099", 10);
  }

  /** Load already-assigned ports from the database on first use */
  private async ensureInitialized() {
    if (this.initialized) return;
    this.initialized = true;
    const existingStreams = await db.select({ port: streams.srtPort }).from(streams);
    for (const row of existingStreams) {
      this.usedPorts.add(row.port);
    }
  }

  async allocatePort(): Promise<number | null> {
    await this.ensureInitialized();
    for (let port = this.portMin; port <= this.portMax; port++) {
      if (!this.usedPorts.has(port)) {
        this.usedPorts.add(port);
        return port;
      }
    }
    return null;
  }

  releasePort(port: number) {
    this.usedPorts.delete(port);
  }

  async start(streamId: string, config: StreamConfig): Promise<void> {
    if (this.processes.has(streamId)) {
      throw new Error("Stream already running");
    }

    await db
      .update(streams)
      .set({ status: "starting", lastError: null, updatedAt: new Date() })
      .where(eq(streams.id, streamId));

    const proc = new StreamProcess(streamId, async (status: StreamStatus) => {
      await this.handleStatusChange(streamId, status, config.srtPort);
    });

    this.processes.set(streamId, proc);

    try {
      await proc.start(config);
      await db
        .update(streams)
        .set({
          status: "running",
          pid: config.srtPort, // use port as a proxy for pid visibility
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(streams.id, streamId));
    } catch (err) {
      this.processes.delete(streamId);
      this.releasePort(config.srtPort);
      await db
        .update(streams)
        .set({
          status: "error",
          lastError: String(err),
          updatedAt: new Date(),
        })
        .where(eq(streams.id, streamId));
      throw err;
    }
  }

  stop(streamId: string): void {
    const proc = this.processes.get(streamId);
    if (!proc) return;
    proc.stop();
    // Actual cleanup happens via onStatusChange callback
  }

  getStatus(streamId: string): StreamStatus | null {
    return this.processes.get(streamId)?.status ?? null;
  }

  getLogs(streamId: string): string[] {
    return this.processes.get(streamId)?.status.logs ?? [];
  }

  isRunning(streamId: string): boolean {
    return this.processes.has(streamId) && (this.processes.get(streamId)?.status.running ?? false);
  }

  /** Delete stopped streams that haven't been used in STREAM_EXPIRY_DAYS (default 14) */
  async cleanupExpiredStreams(): Promise<number> {
    const expiryDays = parseInt(process.env.STREAM_EXPIRY_DAYS ?? "14", 10);
    if (expiryDays <= 0) return 0; // disabled

    const cutoff = new Date(Date.now() - expiryDays * 24 * 60 * 60 * 1000);

    // Only delete stopped streams — never touch running ones
    const expired = await db
      .select({ id: streams.id, port: streams.srtPort })
      .from(streams)
      .where(
        and(
          lt(streams.updatedAt, cutoff),
          ne(streams.status, "running"),
          ne(streams.status, "starting")
        )
      );

    for (const row of expired) {
      await db.delete(streams).where(eq(streams.id, row.id));
      this.releasePort(row.port);
    }

    if (expired.length > 0) {
      console.log(`[cleanup] Deleted ${expired.length} expired stream(s) (unused for ${expiryDays}+ days)`);
    }

    return expired.length;
  }

  /** Start periodic cleanup (call once at startup) */
  startCleanupInterval() {
    // Run immediately on startup
    this.cleanupExpiredStreams().catch(console.error);
    // Then every 6 hours
    setInterval(() => {
      this.cleanupExpiredStreams().catch(console.error);
    }, 6 * 60 * 60 * 1000);
  }

  private async handleStatusChange(
    streamId: string,
    status: StreamStatus,
    port: number
  ) {
    if (!status.running) {
      this.processes.delete(streamId);
      this.releasePort(port);
      await db
        .update(streams)
        .set({
          status: "stopped",
          srtConnected: false,
          pid: null,
          startedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(streams.id, streamId));
    } else {
      await db
        .update(streams)
        .set({
          srtConnected: status.srtConnected,
          updatedAt: new Date(),
        })
        .where(eq(streams.id, streamId));
    }
  }
}

// Singleton — module-level instance
const globalForManager = globalThis as unknown as {
  streamManager: StreamManager | undefined;
};

const isNew = !globalForManager.streamManager;
export const streamManager =
  globalForManager.streamManager ?? new StreamManager();

// Always cache — in production Next.js standalone can re-evaluate modules,
// which would create duplicate StreamManagers with empty port sets.
globalForManager.streamManager = streamManager;

// Start periodic cleanup only once (avoid duplicates on hot-reload)
if (isNew) {
  streamManager.startCleanupInterval();
}

export type { StreamConfig, StreamStatus };
