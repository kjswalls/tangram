/**
 * The spine draw's variant/proper-noun skip, against the real dictionary
 * (PLAN.md §3.3). Run `pnpm data` first.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { getDict } from '@/lib/dict/load';
import { spineEligible } from '@/lib/lists/spine';
import type { DictEntry } from '@/lib/dict/types';
import { requireDictData } from '../dict/data-required';

let entries: DictEntry[];
let byId: Map<string, DictEntry>;

beforeAll(() => {
  requireDictData();
  entries = getDict().entries;
  byId = new Map(entries.map((entry) => [entry.id, entry]));
});

describe('spineEligible', () => {
  it('never drops a word the HSK list bands', () => {
    const banded = entries.filter((entry) => entry.hskBand !== undefined);
    expect(banded.filter((entry) => !spineEligible(entry))).toHaveLength(0);
    // The 113 the literal reading of §3.3 would have lost: 63 proper nouns and
    // 50 "erhua variant of …" entries, six of them in band 1.
    expect(banded.filter((entry) => entry.properNoun || entry.isVariant).length).toBeGreaterThan(
      100,
    );
  });

  it('offers the band-1 words the literal rule would have skipped', () => {
    for (const id of ['中國|中国[Zhong1 guo2]', '一點兒|一点儿[yi1 dian3 r5]']) {
      const entry = byId.get(id) as DictEntry;
      expect(entry.hskBand).toBe(1);
      expect(entry.properNoun || entry.isVariant).toBe(true);
      expect(spineEligible(entry)).toBe(true);
    }
  });

  it('still skips variants and proper nouns outside the bands', () => {
    expect(spineEligible({ isVariant: true, properNoun: false })).toBe(false);
    expect(spineEligible({ isVariant: false, properNoun: true })).toBe(false);
    expect(spineEligible({ isVariant: false, properNoun: false })).toBe(true);
  });
});
