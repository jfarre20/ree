import { sql } from "drizzle-orm";
import {
  text,
  integer,
  sqliteTable,
  real,
} from "drizzle-orm/sqlite-core";

/* ------------------------------------------------------------------ */
/*  Users (populated from Twitch OAuth)                                */
/* ------------------------------------------------------------------ */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(), // Twitch user ID
  username: text("username").notNull(),
  displayName: text("display_name").notNull(),
  profileImage: text("profile_image"),
  email: text("email"),
  twitchStreamKey: text("twitch_stream_key"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/* ------------------------------------------------------------------ */
/*  Sessions (next-auth)                                               */
/* ------------------------------------------------------------------ */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sessionToken: text("session_token").notNull().unique(),
  expires: integer("expires", { mode: "timestamp" }).notNull(),
});

/* ------------------------------------------------------------------ */
/*  Uploaded background videos                                         */
/* ------------------------------------------------------------------ */
export const uploads = sqliteTable("uploads", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(), // stored filename (uuid.mp4)
  originalName: text("original_name").notNull(),
  size: integer("size").notNull(), // bytes
  mimeType: text("mime_type").notNull(),
  uploadedAt: integer("uploaded_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/* ------------------------------------------------------------------ */
/*  Stream configurations                                              */
/* ------------------------------------------------------------------ */
export const streams = sqliteTable("streams", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull().default("My Stream"),

  // SRT listener settings
  srtPort: integer("srt_port").notNull(), // auto-assigned from pool
  srtLatency: integer("srt_latency").notNull().default(150),
  srtPassphrase: text("srt_passphrase"), // optional

  // Output encoding settings
  outWidth: integer("out_width").notNull().default(1280),
  outHeight: integer("out_height").notNull().default(720),
  outFps: integer("out_fps").notNull().default(30),
  videoBitrate: integer("video_bitrate").notNull().default(4000000),
  audioBitrate: integer("audio_bitrate").notNull().default(128000),
  sampleRate: integer("sample_rate").notNull().default(48000),

  // Background video
  backgroundFileId: text("background_file_id").references(() => uploads.id, {
    onDelete: "set null",
  }),

  // Audio behaviour
  bgAudioFadeDelay: real("bg_audio_fade_delay").notNull().default(5.0), // seconds
  bgAudioFadeIn: real("bg_audio_fade_in").notNull().default(2.0),

  // Twitch output (stream key encrypted with NEXTAUTH_SECRET via AES)
  twitchStreamKey: text("twitch_stream_key"), // stored encrypted
  twitchIngestServer: text("twitch_ingest_server")
    .notNull()
    .default("live.twitch.tv"),

  // Runtime state — updated by stream manager
  status: text("status", {
    enum: ["stopped", "starting", "running", "error"],
  })
    .notNull()
    .default("stopped"),
  srtConnected: integer("srt_connected", { mode: "boolean" })
    .notNull()
    .default(false),
  pid: integer("pid"),
  startedAt: integer("started_at", { mode: "timestamp" }),
  lastError: text("last_error"),

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */
export type User = typeof users.$inferSelect;
export type Stream = typeof streams.$inferSelect;
export type Upload = typeof uploads.$inferSelect;
