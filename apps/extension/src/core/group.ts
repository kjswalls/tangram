import type { Cue, Sentence, ZhLine } from './types';

/**
 * Sentence grouping: join Chinese and English cues whose times overlap, so a
 * sentence whose English was reordered across two cues shows as one card.
 *
 * The two tracks are a bipartite graph. A Chinese cue and an English cue are
 * linked when they overlap by at least `minOverlapMs` AND by at least
 * `minOverlapShare` of the shorter cue — up to half a second of timing
 * slop between two otherwise parallel tracks must not chain every line of a
 * conversation into one card. Each connected component is a sentence, capped
 * so a run of linked cues never grows past `maxZh` Chinese lines.
 */
export interface GroupOptions {
  minOverlapMs: number;
  minOverlapShare: number;
  maxZh: number;
  maxDurationMs: number;
}

export const DEFAULT_GROUP_OPTIONS: GroupOptions = {
  minOverlapMs: 500,
  minOverlapShare: 0.25,
  maxZh: 4,
  maxDurationMs: 20_000,
};

export function overlapMs(a: Cue, b: Cue): number {
  return Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
}

function linked(a: Cue, b: Cue, options: GroupOptions): boolean {
  const overlap = overlapMs(a, b);
  if (overlap < options.minOverlapMs) return false;
  const shorter = Math.min(a.endMs - a.startMs, b.endMs - b.startMs);
  return shorter <= 0 || overlap / shorter >= options.minOverlapShare;
}

interface Component {
  zh: number[];
  en: number[];
  startMs: number;
  endMs: number;
}

export function groupSentences(
  zh: readonly ZhLine[],
  en: readonly Cue[],
  options: GroupOptions = DEFAULT_GROUP_OPTIONS,
): Sentence[] {
  // Node ids: zh cues are 0..zh.length-1, en cues follow.
  const parent: number[] = [];
  const parts: Component[] = [];
  const total = zh.length + en.length;
  for (let id = 0; id < total; id += 1) {
    parent.push(id);
    const cue = id < zh.length ? zh[id]! : en[id - zh.length]!;
    parts.push({
      zh: id < zh.length ? [id] : [],
      en: id < zh.length ? [] : [id - zh.length],
      startMs: cue.startMs,
      endMs: cue.endMs,
    });
  }
  const find = (id: number): number => {
    while (parent[id] !== id) {
      parent[id] = parent[parent[id]!]!;
      id = parent[id]!;
    }
    return id;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const pa = parts[ra]!;
    const pb = parts[rb]!;
    const startMs = Math.min(pa.startMs, pb.startMs);
    const endMs = Math.max(pa.endMs, pb.endMs);
    if (pa.zh.length + pb.zh.length > options.maxZh) return;
    if (endMs - startMs > options.maxDurationMs) return;
    parent[rb] = ra;
    parts[ra] = {
      zh: [...pa.zh, ...pb.zh],
      en: [...pa.en, ...pb.en],
      startMs,
      endMs,
    };
  };

  // Both tracks are sorted by start, so a sliding window over `en` finds every overlap.
  let from = 0;
  for (let z = 0; z < zh.length; z += 1) {
    const cue = zh[z]!;
    while (from < en.length && en[from]!.endMs <= cue.startMs) from += 1;
    for (let e = from; e < en.length && en[e]!.startMs < cue.endMs; e += 1) {
      if (linked(cue, en[e]!, options)) union(z, zh.length + e);
    }
  }

  const sentences: Sentence[] = [];
  for (let id = 0; id < total; id += 1) {
    if (find(id) !== id) continue;
    const part = parts[id]!;
    sentences.push({
      id: 0,
      startMs: part.startMs,
      endMs: part.endMs,
      zh: part.zh.sort((a, b) => a - b).map((i) => zh[i]!),
      en: part.en.sort((a, b) => a - b).map((i) => en[i]!),
    });
  }
  sentences.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  // An English-only group (no Chinese overlapped it) is folded into the nearest
  // Chinese sentence within a second, otherwise dropped: a card with no Chinese
  // on it teaches nothing.
  const withZh = sentences.filter((sentence) => sentence.zh.length > 0);
  for (const orphan of sentences) {
    if (orphan.zh.length > 0) continue;
    let best: Sentence | undefined;
    let bestGap = 1000;
    for (const candidate of withZh) {
      const gap = Math.max(candidate.startMs - orphan.endMs, orphan.startMs - candidate.endMs, 0);
      if (gap < bestGap) {
        best = candidate;
        bestGap = gap;
      }
    }
    if (!best) continue;
    best.en.push(...orphan.en);
    best.en.sort((a, b) => a.startMs - b.startMs);
    best.startMs = Math.min(best.startMs, orphan.startMs);
    best.endMs = Math.max(best.endMs, orphan.endMs);
  }
  return withZh.map((sentence, index) => ({ ...sentence, id: index }));
}

/** The sentence playing at `timeMs`, or the last one that started before it. */
export function sentenceAt(sentences: readonly Sentence[], timeMs: number): number {
  let lo = 0;
  let hi = sentences.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sentences[mid]!.startMs <= timeMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
