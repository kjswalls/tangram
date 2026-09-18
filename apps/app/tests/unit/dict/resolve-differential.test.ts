// @vitest-environment node
/**
 * `SqliteDictStore.resolve` against `abe6793`'s implementation, over the real data.
 *
 * `wave-zero.md` §8a says the resolution **rule** survives the port and the
 * implementation does not. That is a claim about behaviour, and the strongest
 * way to check a claim like it is the one `data.md` D2 and D3 already use here:
 * run both implementations in one process over the same 124,188 entries and
 * assert they agree, rather than freezing a golden file that goes stale on the
 * first upstream `pnpm data`.
 *
 * So `resolveWordViaIndex` below is `abe6793:lib/dict/resolve.ts`'s
 * `resolveWord`, **transcribed unchanged** — the in-heap JSON index, the
 * two-script join, the hand-written `compareEntries` and all. It is the version
 * this phase deleted, kept alive here as the oracle, and the assertion is that
 * the SQL answers exactly what it answers: the same `via`, the same entry ids,
 * in the same order.
 *
 * **What this cannot catch**, stated for the same reason `json-oracle.ts`
 * states its own limit: both sides share `lib/dict/pinyin.ts`'s
 * `normalizePinyin` and `lib/dict/rank.ts`'s `hasCjk`, so a bug *in the rule
 * itself* is invisible to it. `resolve-rule.test.ts` pins those directly, and
 * `resolve.test.ts` asserts real ids by value. This covers the part neither
 * can: that the SQL, the schema and the rowid ordering reproduce the index.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { normalizePinyin } from '@/lib/dict/pinyin';
import { hasCjk } from '@/lib/dict/rank';
import { nodeRunner } from '@/lib/dict/runners/node';
import { SqliteDictStore } from '@/lib/dict/sqlite-store';
import type { ResolveVia } from '@/lib/dict/store';
import type { DictEntry, EntryId } from '@/lib/dict/types';

import { exactIds, getDictIndex, type DictIndex } from './json-oracle';
import { dictArtifactPath, requireDictData } from './data-required';

requireDictData();

// ---------------------------------------------------------------------------
// `abe6793:lib/dict/resolve.ts`, transcribed. Do not "improve" it — its value
// is entirely in being the other implementation.
// ---------------------------------------------------------------------------

function compareEntries(a: DictEntry, b: DictEntry): number {
  return (
    (b.freq ?? -1) - (a.freq ?? -1) ||
    Number(a.isVariant) - Number(b.isVariant) ||
    Number(a.properNoun) - Number(b.properNoun) ||
    (a.id < b.id ? -1 : 1)
  );
}

function entriesFor(index: DictIndex, ids: readonly EntryId[]): DictEntry[] {
  const seen = new Set<EntryId>();
  const out: DictEntry[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = index.entries.get(id);
    if (entry) out.push(entry);
  }
  return out;
}

function resolveWordViaIndex(
  index: DictIndex,
  input: string,
): { word: string; via: ResolveVia; entries: DictEntry[] } {
  const word = input.trim();
  if (!word) return { word, via: 'none', entries: [] };

  if (hasCjk(word)) {
    const entries = entriesFor(index, [
      ...(index.bySimp.get(word) ?? []),
      ...(index.byTrad.get(word) ?? []),
    ]).sort(compareEntries);
    return { word, via: entries.length > 0 ? 'hanzi' : 'none', entries };
  }

  const pinyin = normalizePinyin(word);
  if (!pinyin.fullyParsed) return { word, via: 'none', entries: [] };
  const toned = pinyin.syllables.some((syllable) => syllable.tone !== null);
  let ids: EntryId[] = toned ? exactIds(index.byPinyinToned, pinyin.toned) : [];
  if (ids.length === 0) ids = exactIds(index.byPinyinToneless, pinyin.toneless);
  const entries = entriesFor(index, ids);
  return { word, via: entries.length > 0 ? 'pinyin' : 'none', entries };
}

// ---------------------------------------------------------------------------

let store: SqliteDictStore;
let index: DictIndex;

beforeAll(async () => {
  store = new SqliteDictStore({ connect: async () => nodeRunner(dictArtifactPath()) });
  await store.open();
  index = getDictIndex();
});

afterAll(async () => {
  await store.close?.();
});

/** Ask both, in the same order, and report where they differ. */
async function differ(words: readonly string[]): Promise<string[]> {
  const { results } = await store.resolve(words);
  const complaints: string[] = [];
  results.forEach((got, i) => {
    const want = resolveWordViaIndex(index, words[i]);
    if (got.word !== want.word) {
      complaints.push(`${words[i]}: word ${got.word} vs ${want.word}`);
    }
    if (got.via !== want.via) {
      complaints.push(`${words[i]}: via ${got.via} vs ${want.via}`);
    }
    const gotIds = got.entries.map((entry) => entry.id);
    const wantIds = want.entries.map((entry) => entry.id);
    if (gotIds.join('|') !== wantIds.join('|')) {
      complaints.push(`${words[i]}: ids ${gotIds.join(',')} vs ${wantIds.join(',')}`);
    }
  });
  return complaints;
}

describe('the SQL answers what the JSON index answered', () => {
  it('agrees on the words the rule is written about', async () => {
    const words = [
      // Rule 1, both scripts, and the prefix that must not count.
      '你好', '打', '打算', '学习', '學習', '干', '了', '乐', '樂',
      // A headword whose two scripts differ in every character.
      '电脑', '電腦',
      // Rule 2, every spelling of one reading, and the fallback.
      'dǎsuàn', 'da3suan4', 'da3 suan4', 'dasuan', "da3'suan4", 'ni3hao3', 'nihao', 'nǐhǎo',
      'le', 'le5', 'liao3', 'xian', 'nǚ', 'nv3', 'nu:3', 'yi', 'shi', 'zhi',
      // Rule 3.
      'hello', 'xyzzyq', '', '   ', '?!', 'the', 'to',
      // And the shapes a paste actually carries.
      '  打算  ', '卡拉OK', '龘', '你好吗吗吗',
    ];
    expect(await differ(words)).toEqual([]);
  });

  /**
   * A thousand real headwords, taken evenly across the whole frequency range so
   * the sample is not all common words, asked in one call. This is the case a
   * hand-written list cannot reach: it crosses `RESOLVE_HANZI_CHUNK`, so the
   * answer is reassembled from several statements, and any chunk boundary that
   * lost a row or scrambled frequency order shows up as a mismatch.
   */
  it('agrees on a thousand real headwords, in one bulk call', async () => {
    const simps = [...index.bySimp.keys()];
    const step = Math.max(1, Math.floor(simps.length / 1000));
    const sample = simps.filter((_, i) => i % step === 0).slice(0, 1000);
    expect(sample.length).toBe(1000);
    expect(await differ(sample)).toEqual([]);
  });

  it('agrees on a thousand real traditional headwords too', async () => {
    const trads = [...index.byTrad.keys()];
    const step = Math.max(1, Math.floor(trads.length / 1000));
    const sample = trads.filter((_, i) => i % step === 0).slice(0, 1000);
    expect(await differ(sample)).toEqual([]);
  });

  /**
   * And a thousand real *readings*, half spelled with tones and half without,
   * which is the half of the rule the headword samples never exercise — the
   * tone-exact preference and its toneless fallback.
   */
  it('agrees on a thousand real readings, toned and toneless', async () => {
    const toned = index.byPinyinToned.keys;
    const toneless = index.byPinyinToneless.keys;
    const pick = (keys: readonly string[], n: number) => {
      const step = Math.max(1, Math.floor(keys.length / n));
      return keys.filter((_, i) => i % step === 0).slice(0, n);
    };
    const sample = [...pick(toned, 500), ...pick(toneless, 500)];
    expect(sample.length).toBe(1000);
    expect(await differ(sample)).toEqual([]);
  });

  /**
   * The polyphones specifically, because frequency order is what a picker
   * defaults to and a reordering here is a wrong default rather than a missing
   * answer — the kind of disagreement a count-based assertion cannot see.
   */
  it('agrees on the order of every reading of the busiest polyphones', async () => {
    const many = [...index.bySimp.entries()]
      .filter(([, ids]) => ids.length >= 4)
      .slice(0, 400)
      .map(([simp]) => simp);
    expect(many.length).toBeGreaterThan(100);
    expect(await differ(many)).toEqual([]);
  });
});
