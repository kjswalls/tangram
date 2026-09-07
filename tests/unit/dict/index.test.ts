/**
 * Index behaviour, against the real generated dictionary. Run `pnpm data` first.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  exactIds,
  getDictIndex,
  getEntries,
  getEntry,
  glossIds,
  glossTokens,
  hskBand,
  prefixIds,
  stemToken,
} from '@/lib/dict/index';
import { normalizePinyin } from '@/lib/dict/pinyin';
import { requireDictData } from './data-required';

const DASUAN = '打算|打算[da3 suan4]';

beforeAll(requireDictData);

describe('gloss tokenizing', () => {
  it('lowercases, splits and stems', () => {
    expect(glossTokens('to plan; to intend')).toEqual(['to', 'plan', 'intend']);
    expect(stemToken('plans')).toBe('plan');
    expect(stemToken('planning')).toBe('plann');
    expect(stemToken('planned')).toBe('plann');
    expect(stemToken('glass')).toBe('glass');
    expect(stemToken('bus')).toBe('bus');
  });

  it('deduplicates within one gloss', () => {
    expect(glossTokens('plan a plan')).toEqual(['plan', 'a']);
  });
});

describe('entry lookup', () => {
  it('finds an entry by id and keeps the requested order', () => {
    const green = '綠|绿[lu:4]';
    expect(getEntry(DASUAN)?.simp).toBe('打算');
    expect(getEntries([green, DASUAN]).map((e) => e.id)).toEqual([green, DASUAN]);
  });

  it('drops unknown ids instead of throwing', () => {
    expect(getEntry('nope|nope[nope]')).toBeUndefined();
    expect(getEntries(['nope|nope[nope]', DASUAN]).map((e) => e.id)).toEqual([DASUAN]);
  });
});

describe('script indexes', () => {
  it('lists every reading of a headword, most frequent first', () => {
    const index = getDictIndex();
    const ids = index.bySimp.get('了') ?? [];
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const readings = getEntries(ids).map((e) => e.pinyinNum);
    expect(readings).toContain('le5');
    expect(readings).toContain('liao3');
    const freqs = getEntries(ids).map((e) => e.freq ?? -1);
    expect([...freqs].sort((a, b) => b - a)).toEqual(freqs);
  });

  it('indexes traditional forms too', () => {
    expect(getDictIndex().byTrad.get('學習')).toContain('學習|学习[xue2 xi2]');
  });
});

describe('pinyin indexes', () => {
  it('matches an exact toneless and toned reading', () => {
    const index = getDictIndex();
    expect(exactIds(index.byPinyinToneless, 'dasuan')).toContain(DASUAN);
    expect(exactIds(index.byPinyinToned, 'da3suan4')).toContain(DASUAN);
    // 大蒜 shares the toneless key but not the toned one.
    expect(exactIds(index.byPinyinToneless, 'dasuan')).toContain('大蒜|大蒜[da4 suan4]');
    expect(exactIds(index.byPinyinToned, 'da3suan4')).not.toContain('大蒜|大蒜[da4 suan4]');
  });

  it('finds entries by pinyin prefix', () => {
    const ids = prefixIds(getDictIndex().byPinyinToneless, 'dasu', 50);
    expect(ids).toContain(DASUAN);
  });

  it('caps the number of ids a prefix can return', () => {
    expect(prefixIds(getDictIndex().byPinyinToneless, 'shi', 10)).toHaveLength(10);
    expect(prefixIds(getDictIndex().byPinyinToneless, '', 10)).toEqual([]);
  });

  it('folds ü so a learner typing u finds it', () => {
    expect(exactIds(getDictIndex().byPinyinToned, 'lu4')).toContain('綠|绿[lu:4]');
  });

  it('reaches a neutral-tone word from a tone-marked query', () => {
    // `wǒmen` cannot write the neutral tone of 们, so the toned key must not
    // carry it either, or every neutral-tone word drops out of the exact tier.
    const index = getDictIndex();
    const women = '我們|我们[wo3 men5]';
    expect(exactIds(index.byPinyinToned, normalizePinyin('wǒmen').toned)).toContain(women);
    expect(exactIds(index.byPinyinToned, normalizePinyin('wo3 men5').toned)).toContain(women);
    expect(exactIds(index.byPinyinToneless, 'women')).toContain(women);
  });

  it('leaves out headwords CC-CEDICT has no reading for', () => {
    // `xx5` is a placeholder, not a reading: 々 and ㍻ must not answer "xx".
    const index = getDictIndex();
    expect(exactIds(index.byPinyinToneless, 'xx')).toEqual([]);
    expect(exactIds(index.byPinyinToneless, 'xxxx')).toEqual([]);
    expect(getEntry('々|々[xx5]')?.pinyinMarked).toBe('');
  });
});

describe('gloss index', () => {
  it('finds entries by an English word, stemmed the same way at both ends', () => {
    expect(glossIds('plan')).toContain(DASUAN);
    expect(glossIds('plans')).toEqual(glossIds('plan'));
    expect(glossIds('PLAN')).toEqual(glossIds('plan'));
  });

  it('leaves variants out — they are not words in their own right', () => {
    const index = getDictIndex();
    for (const id of glossIds('variant')) {
      expect(index.entries.get(id)?.isVariant).toBe(false);
    }
  });
});

describe('hsk bands', () => {
  it('returns every band, ordered by frequency rank', () => {
    for (const band of [1, 2, 3, 4, 5, 6, 7] as const) {
      const entries = hskBand(band);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.hskBand === band)).toBe(true);
      const ranks = entries.map((e) => e.freqRank ?? Number.MAX_SAFE_INTEGER);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    }
  });

  it('puts the most frequent band 1 words first', () => {
    expect(hskBand(1)[0].freqRank).toBe(1);
  });
});
