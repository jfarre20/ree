import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { uploads } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { createReadStream, statSync } from "fs";
import { Readable } from "stream";
import path from "path";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const row = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.id, params.id), eq(uploads.userId, session.user.id)))
    .get();

  if (!row) return new NextResponse("Not found", { status: 404 });

  const filePath = path.join(
    process.env.UPLOADS_DIR ?? "/home/compositor/uploads",
    row.filename
  );

  let fileSize: number;
  try {
    fileSize = statSync(filePath).size;
  } catch {
    return new NextResponse("File not found on disk", { status: 404 });
  }

  const range = req.headers.get("range");

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? Math.min(parseInt(endStr, 10), fileSize - 1) : fileSize - 1;
    const chunkSize = end - start + 1;

    const nodeStream = createReadStream(filePath, { start, end });
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    return new NextResponse(webStream, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(chunkSize),
        "Content-Type": row.mimeType,
        "Cache-Control": "no-store",
      },
    });
  }

  const nodeStream = createReadStream(filePath);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream;

  return new NextResponse(webStream, {
    status: 200,
    headers: {
      "Content-Length": String(fileSize),
      "Content-Type": row.mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
  });
}
