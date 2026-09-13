/**
 * Search routing and ranking, against the real generated dictionary.
 *
 * Every case here is an acceptance line from PLAN.md §4 (row P1) or the ranking
 * rule from §3.2 it comes from. They run against `data/dict.json` rather than a
 * fixture on purpose: the ranking is a claim about 124,188 real entries, and a
 * hand-made fixture would only prove the sort function sorts.
 */
import { describe, expect, it } from 'vitest';

import { glossSenses, glossTier, search, SEARCH_PAGE_SIZE } from '@/lib/dict/search';
import { getEntry } from '@/lib/dict/index';
import type { DictEntry } from '@/lib/dict/types';
import { requireDictData } from './data-required';

requireDictData();

const DASUAN = '打算|打算[da3 suan4]';

/** Simplified headwords of a result page, in display order. */
function simps(query: string, limit?: number): string[] {
  return search(query, limit ? { limit } : {}).groups.map((group) => group.simp);
}

describe('search routing', () => {
  it('sends anything with a hanzi in it to the hanzi index', () => {
    expect(search('打算').route).toBe('hanzi');
    expect(search('打').route).toBe('hanzi');
  });

  it('runs pinyin and English together when the query parses as pinyin', () => {
    const result = search('sun');
    expect(result.route).toBe('pinyin+english');
    expect(result.sections.map((part) => part.source)).toContain('pinyin');
    expect(result.sections.map((part) => part.source)).toContain('english');
  });

  it('is English-only when the query is not pinyin at all', () => {
    expect(search('plan').route).toBe('english');
    expect(search('to plan').route).toBe('english');
  });

  it('leads with pinyin when tones are typed, with English when the query is a gloss word', () => {
    // §3.2: tone digits/marks or ≥2 syllables → pinyin first; an exact gloss token
    // of ≥3 letters → English first (`sun`, `can`, `women`).
    expect(search('da3suan4').sections[0].source).toBe('pinyin');
    expect(search('dasuan').sections[0].source).toBe('pinyin');
    expect(search('sun').sections[0].source).toBe('english');
    expect(search('can').sections[0].source).toBe('english');
    // Two letters is too short to be a confident English word: 他 still shows, but
    // under the readings of `he`.
    expect(search('he').sections[0].source).toBe('pinyin');
  });

  it('does not read a romanised syllable inside a gloss as an English word', () => {
    // CC-CEDICT romanises inside its English ("jiang shi" for 殭屍, "lüshi form"
    // for 排律), so `shi` is a *token* of 39 glosses without being a word anyone
    // typing it wants. English-first is for a query that is a whole sense of
    // something — 太阳 is "sun" — and this is not.
    expect(search('shi').sections[0].source).toBe('pinyin');
    expect(search('ta').sections[0].source).toBe('pinyin');
    const shi = search('shi').groups.slice(0, 4).map((group) => group.simp);
    expect(shi).toContain('是');
    // …and the words that are English words still lead with English.
    expect(search('sun').sections[0].source).toBe('english');
    expect(search('women').sections[0].source).toBe('english');
  });
});

describe('hanzi search', () => {
  it('puts the exact headword above the words that start with it', () => {
    const result = search('打算');
    expect(result.groups[0].simp).toBe('打算');
    expect(result.groups.map((group) => group.simp)).toContain('打算盘');
  });

  it('accepts traditional input and answers with the simplified headword', () => {
    const result = search('學習');
    expect(result.groups[0].simp).toBe('学习');
    expect(result.groups[0].trad).toBe('學習');
    expect(result.groups[0].entries[0].hskBand).toBe(1);
  });

  it('groups a polyphone into one result carrying every reading', () => {
    const result = search('了');
    const group = result.groups[0];
    expect(group.key).toBe('了|了');
    const readings = group.entries.map((entry) => entry.pinyinMarked);
    expect(readings).toContain('le');
    expect(readings).toContain('liǎo');
    expect(group.hskBand).toBe(1);
  });
});

describe('pinyin search', () => {
  it('finds 打算 first however the reading is typed', () => {
    for (const query of ['dasuan', 'da3suan4', 'dǎsuàn', 'da3 suan4', 'DaSuan']) {
      expect(simps(query)[0], query).toBe('打算');
    }
  });

  it('ranks tone-exact above toneless above prefix', () => {
    const toned = search('da3suan4');
    expect(toned.groups[0].simp).toBe('打算');
    // 大蒜 shares the toneless reading but not the tones, so it drops behind.
    const toneless = simps('dasuan');
    expect(toneless).toContain('大蒜');
    expect(toneless.indexOf('打算')).toBeLessThan(toneless.indexOf('大蒜'));
  });

  it('answers a partial reading by prefix', () => {
    expect(simps('dasu')).toContain('打算');
  });

  it('keeps neutral-tone words reachable from tone marks', () => {
    // `wo3 men5` keys as `wo3men`, so a learner typing `wǒmen` must still land on it.
    expect(simps('wǒmen')[0]).toBe('我们');
  });

  it('folds ü, u: and v onto one reading', () => {
    for (const query of ['lu:4', 'lv4', 'lǜ']) {
      const found = search(query).groups.flatMap((group) => group.entries.map((e) => e.id));
      expect(found, query).toContain('綠|绿[lu:4]');
    }
  });
});

describe('English search', () => {
  it('puts 打算 in the top 3 for `plan`', () => {
    expect(simps('plan').slice(0, 3)).toContain('打算');
  });

  it('ranks a whole-gloss match above the same word inside a longer gloss', () => {
    const order = simps('plan');
    // 打算 has the bare gloss "plan"; 措办's closest is "to plan".
    expect(order.indexOf('打算')).toBeLessThan(order.indexOf('措办'));
  });

  it('finds the pronoun for `he`, not only the character that is read hé', () => {
    const found = simps('he');
    expect(found).toContain('他');
    expect(found).toContain('和');
  });

  it('answers `long` with both the reading and the meaning', () => {
    const found = simps('long');
    expect(found).toContain('龙');
    expect(found).toContain('长');
  });

  it('answers `sun` with both the surname reading and the star', () => {
    const found = simps('sun');
    expect(found).toContain('孙');
    expect(found).toContain('太阳');
  });

  it('lemmatises an irregular plural so `women` finds 女人', () => {
    const found = simps('women');
    expect(found.slice(0, 5)).toContain('女人');
    // …while the reading of the same letters is still there, one section down.
    expect(found).toContain('我们');
  });

  it('splits a semicolon gloss into senses and strips its register notes', () => {
    expect(glossSenses('(third-person singular) (usu. male) he; him; his')).toEqual([
      'he',
      'him',
      'his',
    ]);
    expect(glossSenses('(coll.) to plan')).toEqual(['to plan']);
  });

  it('tiers glosses whole > grammar-words-dropped > phrase > scattered', () => {
    const dasuan = getEntry(DASUAN) as DictEntry;
    expect(glossTier(dasuan, ['plan'])).toBe(0);
    // 措办 is only ever "to plan"; 安排 would not do, since one of its glosses is
    // the bare "plans", which lemmatises onto the query and is a whole-gloss match.
    const cuoban = getEntry('措辦|措办[cuo4 ban4]') as DictEntry;
    expect(glossTier(cuoban, ['plan'])).toBe(1);
    expect(glossTier(dasuan, ['xyzzy'])).toBe(Infinity);
  });
});

describe('result shape', () => {
  it('carries the band, the classifier and the match source on every group', () => {
    const group = search('dasuan').groups[0];
    expect(group.hskBand).toBe(2);
    expect(group.source).toBe('pinyin');
    expect(group.entries[0].classifiers).toEqual(['个']);
    expect(group.matchedIds).toContain(DASUAN);
    expect(group.key).toBe('打算|打算');
  });

  it('reports the dictionary snapshot, so a card can record where it came from', () => {
    expect(search('打算').dictVersion).toMatch(/\d/);
  });

  it('caps a page at 50 groups and hands back a cursor for the rest', () => {
    const first = search('yi');
    expect(first.groups.length).toBeLessThanOrEqual(SEARCH_PAGE_SIZE);
    expect(first.total).toBeGreaterThan(SEARCH_PAGE_SIZE);
    expect(first.nextCursor).toBeDefined();

    const second = search('yi', { cursor: first.nextCursor });
    // `offset` counts groups consumed, which is ≥ the number shown: a headword both
    // sections matched is walked past in the second one.
    expect(second.offset).toBeGreaterThanOrEqual(first.groups.length);
    const firstKeys = new Set(first.groups.map((group) => group.key));
    expect(second.groups.some((group) => firstKeys.has(group.key))).toBe(false);
    expect(second.total).toBe(first.total);
  });

  it('never lists one headword in two sections', () => {
    const result = search('sun');
    const keys = result.groups.map((group) => group.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('answers an empty query with nothing rather than everything', () => {
    expect(search('   ').groups).toEqual([]);
    expect(search('   ').total).toBe(0);
  });

  it('answers a query that matches nothing with an empty page', () => {
    const result = search('zzzqqq');
    expect(result.total).toBe(0);
    expect(result.nextCursor).toBeUndefined();
  });

  it('ranks a real word above a variant of it', () => {
    const order = search('hé').groups.map((group) => group.key);
    // 咊|和 is "old variant of 和"; it must not stand in front of 和 itself.
    expect(order.indexOf('和|和')).toBeLessThan(order.indexOf('咊|和'));
  });
});
