import { z } from "zod";
import { router, protectedProcedure } from "../server";
import { db } from "@/lib/db";
import { streams, uploads } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { streamManager } from "@/lib/stream-manager";
import crypto from "crypto";

const streamUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  srtLatency: z.number().min(20).max(8000).optional(),
  srtPassphrase: z.string().max(79).optional().nullable(),
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
    const port = streamManager.allocatePort();
    if (port === null) {
      throw new Error("No SRT ports available. Too many concurrent streams.");
    }

    const id = crypto.randomUUID();
    await db.insert(streams).values({
      id,
      userId: ctx.userId,
      srtPort: port,
      name: "My Stream",
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

      // Resolve background file path
      let bgFile = process.env.COMPOSITOR_BINARY
        ? require("path").join(
            require("path").dirname(process.env.COMPOSITOR_BINARY),
            "background.mp4"
          )
        : "/home/compositor/compositor/background.mp4";

      if (row.backgroundFileId) {
        const upload = await db
          .select()
          .from(uploads)
          .where(eq(uploads.id, row.backgroundFileId))
          .get();
        if (upload) {
          const uploadsDir =
            process.env.UPLOADS_DIR ?? "/home/compositor/uploads";
          bgFile = require("path").join(uploadsDir, upload.filename);
        }
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
