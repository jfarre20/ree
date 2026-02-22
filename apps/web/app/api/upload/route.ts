import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { uploads } from "@/lib/db/schema";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import crypto from "crypto";

const uploadsDir =
  process.env.UPLOADS_DIR ?? "/home/compositor/uploads";
const MAX_SIZE = 30 * 1024 * 1024; // 30 MB

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  if (!file.type.startsWith("video/")) {
    return NextResponse.json(
      { error: "Only video files are allowed" },
      { status: 400 }
    );
  }

  if (file.size > MAX_SIZE) {
    return NextResponse.json(
      { error: "File too large (max 500 MB)" },
      { status: 400 }
    );
  }

  // Strip anything non-alphanumeric from the extension
  const ext = (file.name.split(".").pop() ?? "mp4").replace(/[^a-z0-9]/gi, "").toLowerCase() || "mp4";
  const filename = `${crypto.randomUUID()}.${ext}`;

  mkdirSync(uploadsDir, { recursive: true });
  const bytes = await file.arrayBuffer();
  writeFileSync(path.join(uploadsDir, filename), Buffer.from(bytes));

  const id = crypto.randomUUID();
  await db.insert(uploads).values({
    id,
    userId: session.user.id,
    filename,
    originalName: file.name,
    size: file.size,
    mimeType: file.type,
  });

  return NextResponse.json({ id, filename });
}
