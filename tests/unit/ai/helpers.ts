/**
 * Shared scaffolding for the ask tests: a `GroundContext` built over the real
 * dictionary. The grounding rules are claims about Chinese words, so they are
 * tested against the words, not against a fixture that could agree with a bug.
 */
import { getDictIndex, getEntry } from '@/lib/dict/index';
import { segment } from '@/lib/dict/segment';
import type { GroundContext } from '@/lib/ai/ground';
import type { Entry } from '@/lib/types';

/** Every reading of each simplified headword, in the dictionary's own order. */
export function entriesFor(...words: string[]): Entry[] {
  const index = getDictIndex();
  const out: Entry[] = [];
  for (const word of words) {
    for (const id of index.bySimp.get(word) ?? []) {
      const entry = getEntry(id);
      if (entry) out.push(entry);
    }
  }
  return out;
}

/** The first (most frequent) reading of a headword. */
export function entryFor(word: string): Entry {
  const [entry] = entriesFor(word);
  if (!entry) throw new Error(`no dictionary entry for ${word}`);
  return entry;
}

/** The reading whose numbered pinyin matches, e.g. `看` `kan1`. */
export function readingOf(word: string, pinyinNum: string): Entry {
  const entry = entriesFor(word).find((candidate) => candidate.pinyinNum === pinyinNum);
  if (!entry) throw new Error(`no ${pinyinNum} reading of ${word}`);
  return entry;
}

export function groundContext(retrieved: Entry[]): GroundContext {
  const index = getDictIndex();
  return {
    retrieved,
    segment: (text) => segment(text).tokens,
    entry: (id) => getEntry(id),
    readings: (simp) => (index.bySimp.get(simp) ?? []).length,
  };
}
