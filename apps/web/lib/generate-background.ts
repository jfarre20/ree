/**
 * Generates a personalised "Be Right Back" background video for a user using ffmpeg.
 *
 * Layout (with pfp):
 *   ┌──────────────────────────────┐
 *   │                              │
 *   │         [ pfp 160px ]        │
 *   │          username            │
 *   │        Reconnecting ...      │  ← dots animate at 0.5 s/frame
 *   │                              │
 *   │        powered by ree        │  ← bottom, subtle
 *   └──────────────────────────────┘
 *
 * Falls back to a plain black screen if ffmpeg or the pfp download fails.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, unlink, access, stat } from "fs/promises";
import crypto from "crypto";
import path from "path";

const execFileAsync = promisify(execFile);

const FONT_PATHS = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
];

async function findFont(): Promise<string | null> {
  for (const f of FONT_PATHS) {
    try { await access(f); return f; } catch {}
  }
  return null;
}

export interface GenerateResult {
  filename: string;
  size: number;
}

/**
 * Generate a personalised background and save it to uploadsDir.
 * Returns the filename (basename) and file size in bytes.
 * Always succeeds — falls back to black screen on any error.
 */
export async function generateUserBackground(opts: {
  username: string;
  pfpUrl: string | null;
  uploadsDir: string;
}): Promise<GenerateResult> {
  const filename = `generated-bg-${crypto.randomUUID()}.mp4`;
  const outputPath = path.join(opts.uploadsDir, filename);

  const tmpPfp = path.join("/tmp", `ree-pfp-${crypto.randomUUID()}.jpg`);
  let hasPfp = false;

  if (opts.pfpUrl) {
    try {
      const res = await fetch(opts.pfpUrl);
      if (res.ok) {
        await writeFile(tmpPfp, Buffer.from(await res.arrayBuffer()));
        hasPfp = true;
      }
    } catch {}
  }

  try {
    const font = await findFont();
    await render({ username: opts.username, pfpPath: hasPfp ? tmpPfp : null, font, outputPath });
  } catch {
    // Any render error → plain black fallback
    await renderBlack(outputPath);
  } finally {
    if (hasPfp) try { await unlink(tmpPfp); } catch {}
  }

  const info = await stat(outputPath);
  return { filename, size: info.size };
}

/**
 * Ensure compositor/black.mp4 exists as the ultimate system fallback.
 * No-op if the file is already present.
 */
export async function ensureBlackFallback(compositorDir: string): Promise<void> {
  const dest = path.join(compositorDir, "black.mp4");
  try { await access(dest); return; } catch {}
  await renderBlack(dest);
}

// ---------------------------------------------------------------------------

async function render(opts: {
  username: string;
  pfpPath: string | null;
  font: string | null;
  outputPath: string;
}) {
  // Twitch login names are alphanumeric+underscore — sanitise anyway
  const username = opts.username.replace(/[\\':]/g, "_");
  const fp = opts.font ? `fontfile=${opts.font}:` : "";

  // Animated "Reconnecting" dots — three drawtext nodes, each active for 0.5 s
  const dotY = opts.pfpPath ? "h/2+115" : "h/2+50";
  const dots = [
    `drawtext=${fp}text='Reconnecting .':fontsize=20:fontcolor=0x888888:x=(w-text_w)/2:y=${dotY}:enable='lt(mod(t,1.5),0.5)'`,
    `drawtext=${fp}text='Reconnecting ..':fontsize=20:fontcolor=0x888888:x=(w-text_w)/2:y=${dotY}:enable='between(mod(t,1.5),0.5,1.0)'`,
    `drawtext=${fp}text='Reconnecting ...':fontsize=20:fontcolor=0x888888:x=(w-text_w)/2:y=${dotY}:enable='gte(mod(t,1.5),1.0)'`,
  ].join(",");

  const poweredBy = `drawtext=${fp}text='powered by ree':fontsize=13:fontcolor=0x2a2a2a:x=(w-text_w)/2:y=h-28`;

  let filterComplex: string;
  let inputs: string[];
  let audioInputIndex: number;

  if (opts.pfpPath) {
    const nameY = "h/2+58";
    const nameDt = `drawtext=${fp}text='${username}':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=${nameY}:shadowcolor=black:shadowx=1:shadowy=1`;
    // overlay: pfp centred horizontally, 90 px above centre vertically
    filterComplex = `[1:v]scale=160:160[pfp];[0:v][pfp]overlay=x=(W-w)/2:y=(H-h)/2-90[bg];[bg]${nameDt},${dots},${poweredBy}[out]`;
    inputs = [
      "-f", "lavfi", "-i", "color=c=0x0d0d0d:s=1280x720:r=30",
      "-loop", "1", "-i", opts.pfpPath,
    ];
    audioInputIndex = 2;
  } else {
    const nameDt = `drawtext=${fp}text='${username}':fontsize=40:fontcolor=white:x=(w-text_w)/2:y=h/2-20:shadowcolor=black:shadowx=1:shadowy=1`;
    filterComplex = `[0:v]${nameDt},${dots},${poweredBy}[out]`;
    inputs = ["-f", "lavfi", "-i", "color=c=0x0d0d0d:s=1280x720:r=30"];
    audioInputIndex = 1;
  }

  await execFileAsync("ffmpeg", [
    "-y",
    ...inputs,
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-map", `${audioInputIndex}:a`,
    "-t", "6",
    "-c:v", "libx264", "-preset", "fast", "-crf", "20",
    "-c:a", "aac", "-b:a", "64k",
    opts.outputPath,
  ], { timeout: 30000 });
}

async function renderBlack(outputPath: string) {
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=30",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-t", "5",
    "-c:v", "libx264", "-preset", "fast", "-crf", "20",
    "-c:a", "aac", "-b:a", "64k",
    outputPath,
  ], { timeout: 15000 });
}
