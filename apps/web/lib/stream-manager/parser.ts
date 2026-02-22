/**
 * Parses JSON status events emitted by srt_compositor on stderr.
 * Handles both the new JSON format and legacy text lines gracefully.
 */

export type CompositorEvent =
  | { event: "started"; stream_id: string; ts: number }
  | { event: "srt_connected"; ts: number; resolution?: string }
  | { event: "srt_dropped"; ts: number }
  | { event: "stats"; ts: number; fps: number; srt_connected: boolean; audio_mode: string }
  | { event: "error"; ts: number; message: string }
  | { event: "stopped"; ts: number };

export function parseCompositorLine(line: string): CompositorEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Try to parse as JSON first
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as CompositorEvent;
    } catch {
      // fall through to text parsing
    }
  }

  // Legacy text format fallback
  const now = Math.floor(Date.now() / 1000);

  if (trimmed.includes("SRT connected!") || trimmed.includes("[srt] Connected")) {
    return { event: "srt_connected", ts: now };
  }
  if (
    trimmed.includes("SRT DROPPED") ||
    trimmed.includes("Timeout, disconnecting") ||
    trimmed.includes("Read error")
  ) {
    return { event: "srt_dropped", ts: now };
  }
  if (trimmed.includes("SRT ACTIVE")) {
    return { event: "srt_connected", ts: now };
  }
  if (trimmed.includes("[done]") || trimmed.includes("Shutdown complete")) {
    return { event: "stopped", ts: now };
  }

  return null;
}
