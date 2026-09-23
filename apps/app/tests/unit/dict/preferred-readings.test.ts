// @vitest-environment node
/**
 * The hand-kept list of preferred readings (`lib/dict/preferred-readings.ts`),
 * pinned against the built artifact.
 *
 * The list is the one place a person decides what the app teaches, and its owner
 * edits it by hand, so this test says plainly what went wrong: an id that does
 * not exist (with the ids that do), two entries fighting over one headword, an
 * entry the ranking would never let win, and an entry that no longer changes
 * anything. Then, **by value**, the reading each headword shows first. The
 * expected pinyin is written out here rather than read from the list, so a
 * typo in the list's id cannot confirm itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PREFERRED_READINGS } from '@/lib/dict/preferred-readings';
import { orderingBand } from '@/lib/dict/rank';
import { nodeRunner } from '@/lib/dict/runners/node';
import { SqliteDictStore } from '@/lib/dict/sqlite-store';
import type { DictEntry } from '@/lib/dict/types';

import { dictArtifactPath, requireDictData } from './data-required';
import { entriesBySimp, getEntry } from './json-oracle';

requireDictData();

let store: SqliteDictStore;

beforeAll(async () => {
  store = new SqliteDictStore({ connect: async () => nodeRunner(dictArtifactPath()) });
  await store.open();
});

afterAll(async () => {
  await store.close();
});

/** `trad|simp[pinyin]` → its two headwords. */
function headwords(id: string): { trad: string; simp: string } {
  const [trad, rest] = id.split('|');
  return { trad, simp: rest.slice(0, rest.indexOf('[')) };
}

/** `compareEntries` without the list: what the artifact would show first if the entry were removed. */
function withoutTheList(a: DictEntry, b: DictEntry): number {
  return (
    (b.freq ?? -1) - (a.freq ?? -1) ||
    Number(a.isVariant) - Number(b.isVariant) ||
    Number(a.properNoun) - Number(b.properNoun) ||
    orderingBand(a) - orderingBand(b) ||
    (a.id < b.id ? -1 : 1)
  );
}

/**
 * Every reading of a headword, first first, as the artifact orders them.
 * `resolve` rather than `segment`: 不了 on its own segments as 不 + 了, and a
 * headword's readings are in rowid order either way.
 */
async function readingsOf(word: string): Promise<string[]> {
  const { results } = await store.resolve([word]);
  return results[0].entries.map((entry) => entry.id);
}

describe('the preferred-readings list', () => {
  it.each(PREFERRED_READINGS.map((reading) => [reading.id, reading.reason]))(
    '%s exists and gives a one-line reason',
    (id, reason) => {
      const real = entriesBySimp(headwords(id).simp).map((entry) => entry.id);
      expect(getEntry(id), `${id} is not in the dictionary; ${headwords(id).simp} has ${real.join(', ')}`).toBeDefined();
      expect(reason.trim().length, `${id} needs a reason`).toBeGreaterThan(0);
      expect(reason, `${id}: keep the reason on one line`).not.toMatch(/\n/);
    },
  );

  it('names each headword once', () => {
    const seen = new Map<string, string>();
    for (const { id } of PREFERRED_READINGS) {
      const { trad, simp } = headwords(id);
      for (const key of [`simp ${simp}`, `trad ${trad}`]) {
        expect(seen.get(key), `${id} and ${seen.get(key)} both want to be first for ${key}`).toBeUndefined();
        seen.set(key, id);
      }
    }
  });

  it('holds only entries the ranking lets win: no variant, no proper noun', () => {
    for (const { id } of PREFERRED_READINGS) {
      const entry = getEntry(id) as DictEntry;
      expect(entry.isVariant, `${id} is a variant, which every ordinary reading outranks`).toBe(false);
      expect(entry.properNoun, `${id} is a proper noun, which every ordinary reading outranks`).toBe(false);
    }
  });

  it('holds only entries that change something: without the list, each headword shows another reading first', () => {
    for (const { id } of PREFERRED_READINGS) {
      const readings = entriesBySimp(headwords(id).simp);
      const first = [...readings].sort(withoutTheList)[0];
      expect(first.id, `${id} is already first without the list; remove it`).not.toBe(id);
    }
  });
});

describe('the reading each preferred headword shows first', () => {
  /** Simplified headword → the pinyin the app should teach first. Written out, not read from the list. */
  const FIRST: [word: string, pinyin: string][] = [
    ['说道', 'shuōdào'],
    ['壳', 'ké'],
    ['唉', 'āi'],
    ['奔', 'bēn'],
    ['哇', 'wā'],
    ['么', 'me'],
    ['奇', 'qí'],
    ['似', 'sì'],
    ['伯', 'bó'],
    ['殷', 'yīn'],
    ['屏', 'píng'],
    ['咖', 'kā'],
    ['石', 'shí'],
    ['体', 'tǐ'],
    ['居', 'jū'],
    ['叶', 'yè'],
    ['华', 'huá'],
    ['渐', 'jiàn'],
    ['遂', 'suì'],
    ['圣', 'shèng'],
    ['骨', 'gǔ'],
    ['岭', 'lǐng'],
    ['校', 'xiào'],
    ['陆', 'lù'],
    ['济', 'jì'],
    ['颈', 'jǐng'],
    ['摩', 'mó'],
    ['禁', 'jìn'],
    ['隆', 'lóng'],
    ['囊', 'náng'],
    ['舌', 'shé'],
    ['姆', 'mǔ'],
    ['秘', 'mì'],
    ['委', 'wěi'],
    ['嵌', 'qiàn'],
    ['倘', 'tǎng'],
    ['渠', 'qú'],
    ['予', 'yǔ'],
    ['仆', 'pú'],
    ['肚', 'dù'],
    ['较差', 'jiàochà'],
    ['不了', 'bùliǎo'],
    ['小子', 'xiǎozi'],
  ];

  it('covers the whole list, and nothing else', () => {
    expect(FIRST.map(([word]) => word).sort()).toEqual(
      PREFERRED_READINGS.map(({ id }) => headwords(id).simp).sort(),
    );
  });

  it.each(FIRST)('%s is %s', async (word, pinyin) => {
    const [first] = await readingsOf(word);
    const [entry] = await store.entries([first]);
    expect(entry.pinyinMarked).toBe(pinyin);
  });

  it.each(PREFERRED_READINGS.map(({ id }) => [headwords(id).trad, id]))(
    'traditional %s shows %s first too',
    async (word, id) => {
      expect((await readingsOf(word))[0]).toBe(id);
    },
  );

  it('keeps every other reading', async () => {
    expect(await readingsOf('壳')).toEqual(['殼|壳[ke2]', '殼|壳[qiao4]', '殻|壳[qiao4]']);
    // 么 is also the traditional form of 幺 yāo, which `resolve` returns after these.
    expect((await readingsOf('么')).filter((id) => id.includes('|么['))).toEqual([
      '麼|么[me5]',
      '麼|么[ma2]',
      '麼|么[ma5]',
      '麽|么[me5]',
    ]);
  });

  it('reaches the reader: 鸡蛋的壳 ends on ké', async () => {
    const { tokens } = await store.segment('鸡蛋的壳');
    const last = tokens[tokens.length - 1];
    expect(last.text).toBe('壳');
    expect(last.entryIds?.[0]).toBe('殼|壳[ke2]');
  });
});
