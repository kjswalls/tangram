/**
 * The Phase 0 data acceptance checks (PLAN.md §4). These run against the real
 * `data/dict.json`, so `pnpm data` has to have been run; a missing build fails here
 * with that instruction rather than skipping.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { getDecomp, getDict } from '@/lib/dict/load';
import { requireDictData } from './dict/data-required';
import type { DictEntry } from '@/lib/dict/types';

let entries: DictEntry[];
let byId: Map<string, DictEntry>;

beforeAll(() => {
  requireDictData();
  entries = getDict().entries;
  byId = new Map(entries.map((entry) => [entry.id, entry]));
});

describe('dict.json', () => {
  it('carries the snapshot it was built from', () => {
    const { meta } = getDict();
    expect(meta.version).toMatch(/\d/);
    expect(Date.parse(meta.builtAt)).not.toBeNaN();
    expect(meta.sources.map((s) => s.license)).toContain('CC BY-SA 4.0');
    // The derived tone marks are a modification and must say so.
    expect(meta.sources.find((s) => s.name === 'CC-CEDICT')?.modifications).toMatch(/pinyin/i);
  });

  it('has unique ids of the form trad|simp[pinyin]', () => {
    expect(entries.length).toBeGreaterThan(100_000);
    expect(byId.size).toBe(entries.length);
    for (const entry of entries.slice(0, 500)) {
      expect(entry.id).toBe(`${entry.trad}|${entry.simp}[${entry.pinyinNum}]`);
    }
  });
});

describe('打算', () => {
  const id = '打算|打算[da3 suan4]';

  it('has the fields the app renders', () => {
    const entry = byId.get(id) as DictEntry;
    expect(entry).toBeDefined();
    expect(entry.pinyinNum).toBe('da3 suan4');
    expect(entry.pinyinMarked).toBe('dǎsuàn');
    expect(entry.hskBand).toBe(2);
    expect(entry.freqRank).toBeGreaterThan(0);
    expect(entry.freq).toBeGreaterThan(0);
    expect(entry.glosses).toContain('to plan');
  });

  it('lifts its classifier out of the glosses', () => {
    const entry = byId.get(id) as DictEntry;
    expect(entry.classifiers).toEqual(['个']);
    expect(entry.glosses.some((gloss) => gloss.startsWith('CL:'))).toBe(false);
  });
});

describe('classifiers', () => {
  it('lifts the inline "(CL:…)" form too, not just the standalone line', () => {
    // CC-CEDICT appends `(CL:座[zuo4])` to the sense it belongs to for 83 entries,
    // 60 of them HSK-banded. Left in place it is baked into every card snapshot.
    expect(entries.filter((entry) => entry.glosses.some((g) => /CL:/.test(g)))).toHaveLength(0);

    const shan = byId.get('山|山[shan1]') as DictEntry;
    expect(shan.classifiers).toEqual(['座']);
    expect(shan.glosses[0]).toBe('mountain; hill');

    const dongzuo = byId.get('動作|动作[dong4 zuo4]') as DictEntry;
    expect(dongzuo.classifiers).toEqual(['个']);
    expect(dongzuo.glosses).toContain('movement; motion; action');
  });

  it('never leaves an entry with an empty gloss list behind', () => {
    expect(entries.filter((entry) => entry.glosses.length === 0)).toHaveLength(0);
  });
});

describe('pos', () => {
  it('comes from the HSK list only, in the HSK list\'s own vocabulary', () => {
    // jieba's tags (`n`, `v`, `nr`) are a different vocabulary and are not merged
    // in; see HANDOFF.md. So `pos` exists for banded entries or not at all.
    const withPos = entries.filter((entry) => entry.pos !== undefined);
    expect(withPos.length).toBeGreaterThan(9_000);
    expect(withPos.every((entry) => entry.hskBand !== undefined)).toBe(true);

    // Slash-separated HSK tags out of a closed set: `V/N`, `Adj`, `M`.
    const tags = new Set(withPos.flatMap((entry) => (entry.pos as string).split('/')));
    expect([...tags].sort()).toEqual([
      'Adj',
      'Adv',
      'Aux',
      'Conj',
      'Intj',
      'M',
      'N',
      'Num',
      'Phonetic',
      'Pr',
      'Prefix',
      'Prep',
      'Pron',
      'Suffix',
      'V',
    ]);
  });
});

describe('绿', () => {
  it('keeps the two readings apart and bands only the one HSK lists', () => {
    const green = entries.filter((entry) => entry.simp === '绿');
    expect(green).toHaveLength(2);
    expect(new Set(green.map((entry) => entry.id)).size).toBe(2);

    const lu = byId.get('綠|绿[lu:4]') as DictEntry;
    const luName = byId.get('綠|绿[lu4]') as DictEntry;
    expect(lu.pinyinMarked).toBe('lǜ');
    expect(lu.hskBand).toBe(2);
    expect(luName.pinyinMarked).toBe('lù');
    expect(luName.hskBand).toBeUndefined();
  });
});

describe('the HSK spine', () => {
  it('has words in every one of the seven bands', () => {
    const counts = new Map<number, number>();
    for (const entry of entries) {
      if (entry.hskBand === undefined) continue;
      counts.set(entry.hskBand, (counts.get(entry.hskBand) ?? 0) + 1);
    }
    for (const band of [1, 2, 3, 4, 5, 6, 7]) {
      expect(counts.get(band) ?? 0).toBeGreaterThan(0);
    }
    expect(counts.get(8)).toBeUndefined(); // 7 is the band labelled "7-9"
  });
});

describe('entry flags', () => {
  it('marks variants, proper nouns and surnames', () => {
    const variant = byId.get('㐅|㐅[wu3]') as DictEntry;
    expect(variant.isVariant).toBe(true);
    expect(variant.variantOf).toBe('五|五[wu3]');

    expect((byId.get('丁|丁[Ding1]') as DictEntry).surname).toBe(true);
    expect((byId.get('北京|北京[Bei3 jing1]') as DictEntry).properNoun).toBe(true);
    expect((byId.get('打算|打算[da3 suan4]') as DictEntry).properNoun).toBe(false);
  });
});

describe('decomp.json', () => {
  it('decomposes characters and stays out of the dictionary file', () => {
    const decomp = getDecomp();
    expect(decomp['打']).toBeDefined();
    expect(decomp['打'].decomposition).toBe('⿰扌丁');
    expect(decomp['打'].radical).toBe('扌');
    expect(Object.keys(decomp).length).toBeGreaterThan(5_000);
    expect('decomposition' in (byId.get('打|打[da3]') as DictEntry)).toBe(false);
  });
});
