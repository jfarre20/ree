import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import path from "path";
import fs from "fs";

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "../../data");
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "reestreamer.db");
const sqlite = new Database(dbPath);

// WAL mode for better concurrent read performance
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

// Add columns introduced after initial schema (SQLite has no IF NOT EXISTS for ALTER)
try { sqlite.exec(`ALTER TABLE users ADD COLUMN twitch_stream_key TEXT;`); } catch (_) { /* already exists */ }
try { sqlite.exec(`ALTER TABLE users ADD COLUMN default_background_id TEXT;`); } catch (_) { /* already exists */ }
try { sqlite.exec(`ALTER TABLE streams ADD COLUMN reconnect_timeout INTEGER NOT NULL DEFAULT 86400;`); } catch (_) { /* already exists */ }

// Run initial migrations inline (simple approach for single-server deploy)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    profile_image TEXT,
    email TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token TEXT NOT NULL UNIQUE,
    expires INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS streams (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'My Stream',
    srt_port INTEGER NOT NULL,
    srt_latency INTEGER NOT NULL DEFAULT 150,
    srt_passphrase TEXT,
    out_width INTEGER NOT NULL DEFAULT 1280,
    out_height INTEGER NOT NULL DEFAULT 720,
    out_fps INTEGER NOT NULL DEFAULT 30,
    video_bitrate INTEGER NOT NULL DEFAULT 4000000,
    audio_bitrate INTEGER NOT NULL DEFAULT 128000,
    sample_rate INTEGER NOT NULL DEFAULT 48000,
    background_file_id TEXT REFERENCES uploads(id) ON DELETE SET NULL,
    bg_audio_fade_delay REAL NOT NULL DEFAULT 5.0,
    bg_audio_fade_in REAL NOT NULL DEFAULT 2.0,
    twitch_stream_key TEXT,
    twitch_ingest_server TEXT NOT NULL DEFAULT 'live.twitch.tv',
    status TEXT NOT NULL DEFAULT 'stopped',
    srt_connected INTEGER NOT NULL DEFAULT 0,
    pid INTEGER,
    started_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

export type { User, Stream, Upload } from "./schema";
