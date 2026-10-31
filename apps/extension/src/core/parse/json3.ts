import type { Cue } from '../types';

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  aAppend?: number;
  segs?: { utf8?: string }[];
}

/**
 * YouTube's `fmt=json3` timed text. Auto-generated tracks also carry
 * window-positioning events with no `segs` and `aAppend` line breaks; both are
 * dropped, and a cue with no visible text is not a cue.
 */
export function parseJson3(body: string | { events?: Json3Event[] }): Cue[] {
  const data = typeof body === 'string' ? (JSON.parse(body) as { events?: Json3Event[] }) : body;
  const cues: Cue[] = [];
  for (const event of data.events ?? []) {
    if (!event.segs || event.aAppend) continue;
    const text = event.segs
      .map((seg) => seg.utf8 ?? '')
      .join('')
      .replace(/\s*\n\s*/g, ' ')
      .trim();
    if (!text) continue;
    const startMs = event.tStartMs ?? 0;
    cues.push({ startMs, endMs: startMs + (event.dDurationMs ?? 0), text });
  }
  return normaliseCues(cues);
}

/** Sort, and clip each cue so it never runs past the next one's start. */
export function normaliseCues(cues: Cue[]): Cue[] {
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const next = sorted[i + 1]!;
    if (sorted[i]!.endMs > next.startMs && next.startMs > sorted[i]!.startMs) {
      sorted[i] = { ...sorted[i]!, endMs: next.startMs };
    }
  }
  return sorted;
}
