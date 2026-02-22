/**
 * StreamManager — singleton that owns all active compositor processes.
 * Imported by tRPC server routes to start/stop/monitor streams.
 *
 * Lives entirely on the server (Node.js) — never imported by client code.
 */

import { StreamProcess, type StreamConfig, type StreamStatus } from "./process";
import { db } from "@/lib/db";
import { streams } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

class StreamManager {
  private processes = new Map<string, StreamProcess>();
  private portPool: Set<number>;

  constructor() {
    const min = parseInt(process.env.SRT_PORT_MIN ?? "6000", 10);
    const max = parseInt(process.env.SRT_PORT_MAX ?? "6099", 10);
    this.portPool = new Set(Array.from({ length: max - min + 1 }, (_, i) => min + i));
  }

  allocatePort(): number | null {
    const iter = this.portPool.values().next();
    if (iter.done) return null;
    const port = iter.value;
    this.portPool.delete(port);
    return port;
  }

  releasePort(port: number) {
    this.portPool.add(port);
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

export const streamManager =
  globalForManager.streamManager ?? new StreamManager();

if (process.env.NODE_ENV !== "production") {
  globalForManager.streamManager = streamManager;
}

export type { StreamConfig, StreamStatus };
