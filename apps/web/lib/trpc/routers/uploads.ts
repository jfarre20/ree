import { z } from "zod";
import { router, protectedProcedure } from "../server";
import { db } from "@/lib/db";
import { uploads } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { unlinkSync } from "fs";
import path from "path";

const uploadsDir =
  process.env.UPLOADS_DIR ?? "/home/compositor/uploads";

export const uploadsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return db
      .select()
      .from(uploads)
      .where(eq(uploads.userId, ctx.userId));
  }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const row = await db
        .select()
        .from(uploads)
        .where(and(eq(uploads.id, input.id), eq(uploads.userId, ctx.userId)))
        .get();
      if (!row) throw new Error("Upload not found");

      try {
        unlinkSync(path.join(uploadsDir, row.filename));
      } catch {
        // File may already be gone
      }

      await db
        .delete(uploads)
        .where(and(eq(uploads.id, input.id), eq(uploads.userId, ctx.userId)));

      return { ok: true };
    }),
});
