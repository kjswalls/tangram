/**
 * Reading the golden fixtures back (docs/plans/data.md D6).
 *
 * `golden/search.json` and `../ai/golden/retrieve.json` are what the JSON
 * implementation answered on the commit before D6 deleted it. See
 * `golden/README.md` for what is frozen, what deliberately is not, and the
 * generator, kept there verbatim because a `.ts` importing five deleted modules
 * is a tree that does not typecheck.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect } from 'vitest';

import { dataDir } from '@/lib/server/roots';
import searchFixture from './golden/search.json';
import retrieveFixture from '../ai/golden/retrieve.json';

/**
 * A long list, frozen as its length, its first twenty entries and a digest over
 * the whole thing **in order**.
 *
 * A lost key, a reordered pair or a silently lowered cap changes the digest;
 * `head` is there so the failure is readable rather than one hex string against
 * another.
 */
export interface FrozenList {
  count: number;
  head: string[];
  sha256: string;
}

interface Provenance {
  dictVersion: string;
  entryCount: number;
  /**
   * A digest of `data/dict.json`'s **entries**, not of the file.
   *
   * The file carries `meta.builtAt`, so hashing it whole detects a *rebuild*
   * rather than a change of data, and every `pnpm data` run would report the
   * fixtures stale. The entries array is what every frozen answer depends on and
   * it is byte-stable across rebuilds of the same sources — the artifact's own
   * sha256 is too, which is `data.md` D1's reproducibility criterion and the
   * evidence that this holds.
   */
  dictEntriesSha256: string;
  frozenBy: string;
}

interface SearchGolden {
  provenance: Provenance;
  corpus: string[];
  hanzi: Record<string, { route: string; sections: string[]; hanziKeys: FrozenList }>;
  pinyin: Record<string, { route: string; sections: string[]; pinyinKeys: FrozenList }>;
  gloss: Record<string, string[]>;
  routing: Record<string, string[]>;
  paging: Record<string, { total: number; pages: number; keys: string[] }>;
  longPassage: { chars: number; textSha256: string; tokenCount: number; tokensSha256: string };
}

interface RetrieveGolden {
  provenance: Provenance;
  mergedSearch: Record<string, string[]>;
  candidateEntries: { phrases: string[]; ids: string[] }[];
}

export const goldenSearch = searchFixture as SearchGolden;
export const goldenRetrieve = retrieveFixture as RetrieveGolden;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

let dictSha: string | undefined;

/** The digest of `data/dict.json`'s entries as they are on disk now. Computed once. */
export function dictEntriesSha256(): string {
  if (dictSha === undefined) {
    const file = JSON.parse(readFileSync(resolve(dataDir(), 'dict.json'), 'utf8')) as {
      entries: unknown[];
    };
    dictSha = sha256(JSON.stringify(file.entries));
  }
  return dictSha;
}

/**
 * Whether the data these fixtures were cut from is still the data on disk.
 *
 * `pnpm data` reads CC-CEDICT from a pinned npm package but pulls the HSK list,
 * the jieba frequencies and Make Me a Hanzi from `master` branches, so the
 * generated dictionary *can* move under a fixture. When it does, the fixtures
 * are stale rather than wrong, and every assertion built on them is suspect —
 * which is why `golden.test.ts` says so by name and by itself, rather than
 * leaving somebody to infer it from thirty failures at once.
 */
export function goldenIsFresh(): boolean {
  return goldenSearch.provenance.dictEntriesSha256 === dictEntriesSha256();
}

export const STALE_HINT =
  'the golden fixtures were frozen from different dictionary entries. `pnpm data` pulls HSK, ' +
  'jieba and Make Me a Hanzi from master branches, so the dictionary can move under them. ' +
  'They cannot be regenerated — the JSON implementation they came from was deleted in ' +
  'data.md D6 — so re-blessing is a human judgement: read the diffs below, decide whether the ' +
  'new answers are right, and record the decision. apps/app/tests/unit/dict/golden/README.md.';

/**
 * Compare a list against its frozen form.
 *
 * The count and the head are asserted **before** the digest, deliberately: a
 * digest mismatch on its own says only "something moved", and these two usually
 * say what.
 */
export function expectFrozenList(
  actual: readonly string[],
  frozen: FrozenList,
  label: string,
): void {
  expect(actual.length, `${label}: length`).toBe(frozen.count);
  expect(actual.slice(0, frozen.head.length), `${label}: first ${frozen.head.length}`).toEqual(
    frozen.head,
  );
  expect(sha256(actual.join('\n')), `${label}: digest over the whole list, in order`).toBe(
    frozen.sha256,
  );
}
