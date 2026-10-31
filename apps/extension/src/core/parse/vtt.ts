import type { Cue } from '../types';
import { normaliseCues } from './json3';

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

export function parseTimestamp(value: string): number {
  const m = TIME.exec(value);
  if (!m) return Number.NaN;
  const [, h, min, s, ms] = m;
  return ((Number(h ?? 0) * 60 + Number(min)) * 60 + Number(s)) * 1000 + Number(ms!.padEnd(3, '0'));
}

/** Strip VTT/SRT inline markup (`<c.yellow>`, `<i>`, `{\an8}`) and decode the common entities. */
export function cleanCueText(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/** WebVTT and SRT share a shape once the header and cue numbers are ignored. */
export function parseVtt(body: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = body.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at === -1) continue;
    const [from, to] = lines[at]!.split('-->');
    const startMs = parseTimestamp(from ?? '');
    const endMs = parseTimestamp(to ?? '');
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
    const text = cleanCueText(lines.slice(at + 1).join('\n'));
    if (text) cues.push({ startMs, endMs, text });
  }
  return normaliseCues(cues);
}

export const parseSrt = parseVtt;
