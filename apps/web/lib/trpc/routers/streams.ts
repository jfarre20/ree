import { z } from "zod";
import { router, protectedProcedure } from "../server";
import { db } from "@/lib/db";
import { streams, uploads, users } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { streamManager } from "@/lib/stream-manager";
import { ensureBlackFallback } from "@/lib/generate-background";
import crypto from "crypto";
import path from "path";
import { existsSync } from "fs";

const streamUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  srtLatency: z.number().min(20).max(8000).optional(),
  outWidth: z.number().min(320).max(1920).optional(),
  outHeight: z.number().min(240).max(1080).optional(),
  outFps: z.number().min(15).max(60).optional(),
  videoBitrate: z.number().min(500000).max(12000000).optional(),
  audioBitrate: z.number().min(64000).max(320000).optional(),
  sampleRate: z.number().refine((v) => [44100, 48000].includes(v)).optional(),
  backgroundFileId: z.string().nullable().optional(),
  bgAudioFadeDelay: z.number().min(0).max(30).optional(),
  bgAudioFadeIn: z.number().min(0).max(10).optional(),
  twitchStreamKey: z.string().max(200).optional(),
  twitchIngestServer: z.string().optional(),
});

export const streamsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await db
      .select()
      .from(streams)
      .where(eq(streams.userId, ctx.userId));

    return rows.map((s) => ({
      ...s,
      // Enrich with live status from manager
      liveStatus: streamManager.getStatus(s.id),
    }));
  }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const row = await db
        .select()
        .from(streams)
        .where(and(eq(streams.id, input.id), eq(streams.userId, ctx.userId)))
        .get();
      if (!row) throw new Error("Stream not found");

      return {
        ...row,
        liveStatus: streamManager.getStatus(row.id),
      };
    }),

  create: protectedProcedure.mutation(async ({ ctx }) => {
    const port = await streamManager.allocatePort();
    if (port === null) {
      throw new Error(
        "This server is full — all SRT ports are in use. " +
        "Delete unused streams to free up ports, or contact the server admin to expand the port pool."
      );
    }

    const user = await db.select().from(users).where(eq(users.id, ctx.userId)).get();

    // Auto-generate a 16-char alphanumeric passphrase for SRT encryption
    const passphrase = crypto.randomBytes(12).toString("base64url").slice(0, 16);

    const id = crypto.randomUUID();
    await db.insert(streams).values({
      id,
      userId: ctx.userId,
      srtPort: port,
      srtPassphrase: passphrase,
      name: "My Stream",
      twitchStreamKey: user?.twitchStreamKey ?? null,
      backgroundFileId: user?.defaultBackgroundId ?? null,
    });

    return { id };
  }),

  update: protectedProcedure
    .input(z.object({ id: z.string(), data: streamUpdateSchema }))
    .mutation(async ({ ctx, input }) => {
      const existing = await db
        .select()
        .from(streams)
        .where(and(eq(streams.id, input.id), eq(streams.userId, ctx.userId)))
        .get();
      if (!existing) throw new Error("Stream not found");
      if (existing.status === "running") {
        throw new Error("Stop the stream before changing settings");
      }

      await db
        .update(streams)
        .set({ ...input.data, updatedAt: new Date() })
        .where(eq(streams.id, input.id));

      return { ok: true };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const row = await db
        .select()
        .from(streams)
        .where(and(eq(streams.id, input.id), eq(streams.userId, ctx.userId)))
        .get();
      if (!row) throw new Error("Stream not found");
      if (row.status === "running") {
        streamManager.stop(input.id);
      }
      await db.delete(streams).where(eq(streams.id, input.id));
      streamManager.releasePort(row.srtPort);
      return { ok: true };
    }),

  start: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const row = await db
        .select()
        .from(streams)
        .where(and(eq(streams.id, input.id), eq(streams.userId, ctx.userId)))
        .get();
      if (!row) throw new Error("Stream not found");
      if (!row.twitchStreamKey) throw new Error("No Twitch stream key configured");

      // Resolve background file with fallback chain:
      //   1. Stream's selected upload (if file exists on disk)
      //   2. User's auto-generated default background
      //   3. compositor/black.mp4  (generated on-demand if missing)
      const uploadsDir = process.env.UPLOADS_DIR ?? "/home/compositor/uploads";
      const compositorDir = process.env.COMPOSITOR_BINARY
        ? path.dirname(process.env.COMPOSITOR_BINARY)
        : "/home/compositor/compositor";
      const blackMp4 = path.join(compositorDir, "black.mp4");

      const resolveUpload = async (uploadId: string | null): Promise<string | null> => {
        if (!uploadId) return null;
        const upload = await db.select().from(uploads).where(eq(uploads.id, uploadId)).get();
        if (!upload) return null;
        const filePath = path.join(uploadsDir, upload.filename);
        return existsSync(filePath) ? filePath : null;
      };

      let bgFile =
        (await resolveUpload(row.backgroundFileId)) ??
        (await resolveUpload(row.userId ? (await db.select({ d: users.defaultBackgroundId }).from(users).where(eq(users.id, row.userId)).get())?.d ?? null : null)) ??
        blackMp4;

      // Ensure the final fallback exists
      if (bgFile === blackMp4) {
        await ensureBlackFallback(compositorDir);
      }

      await streamManager.start(input.id, {
        streamId: input.id,
        srtPort: row.srtPort,
        srtLatency: row.srtLatency,
        srtPassphrase: row.srtPassphrase ?? undefined,
        bgFile,
        outWidth: row.outWidth,
        outHeight: row.outHeight,
        outFps: row.outFps,
        videoBitrate: row.videoBitrate,
        audioBitrate: row.audioBitrate,
        sampleRate: row.sampleRate,
        bgAudioFadeDelay: row.bgAudioFadeDelay,
        twitchStreamKey: row.twitchStreamKey,
        twitchIngestServer: row.twitchIngestServer,
      });

      return { ok: true };
    }),

  stop: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const row = await db
        .select()
        .from(streams)
        .where(and(eq(streams.id, input.id), eq(streams.userId, ctx.userId)))
        .get();
      if (!row) throw new Error("Stream not found");
      streamManager.stop(input.id);
      return { ok: true };
    }),

  regenerateStreamKey: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const row = await db
        .select()
        .from(streams)
        .where(and(eq(streams.id, input.id), eq(streams.userId, ctx.userId)))
        .get();
      if (!row) throw new Error("Stream not found");
      if (row.status === "running") {
        throw new Error("Stop the stream before regenerating the stream key");
      }

      const passphrase = crypto.randomBytes(12).toString("base64url").slice(0, 16);
      await db
        .update(streams)
        .set({ srtPassphrase: passphrase, updatedAt: new Date() })
        .where(eq(streams.id, input.id));

      return { ok: true, passphrase };
    }),

  getLogs: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const row = await db
        .select({ id: streams.id })
        .from(streams)
        .where(and(eq(streams.id, input.id), eq(streams.userId, ctx.userId)))
        .get();
      if (!row) throw new Error("Stream not found");
      return streamManager.getLogs(input.id);
    }),
});
