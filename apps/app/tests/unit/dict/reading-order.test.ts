// @vitest-environment node
/**
 * The reading a headword shows first, which is the reading the app teaches.
 *
 * The reader's ruby, the character sheet's default, the "Add" button and the
 * order of readings in every sheet all take a headword's **first** entry, and
 * the first entry is whatever `compareEntries` put first when the artifact was
 * built. The hand-kept preferred readings have their own test,
 * `preferred-readings.test.ts`. Before the band tie-break the id decided among readings that share a
 * jieba frequency — every reading of a headword does — so `吗[ma2]` beat
 * `吗[ma5]` alphabetically and the first-run audit found 说 as shuì, 要 as yāo
 * and 你想跟我一起去吗 ending in "má" (HANDOFF.md "First-run audit", defect 1).
 *
 * The expectations below are **by value**, against the built artifact, not
 * against another implementation of the same order: the thing that went wrong
 * was the order itself, so an oracle that shares it could not have caught it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { compareEntries, isCrossReferenceOnly } from '@/lib/dict/rank';
import { nodeRunner } from '@/lib/dict/runners/node';
import { SqliteDictStore } from '@/lib/dict/sqlite-store';
import type { DictEntry } from '@/lib/dict/types';

import { dictArtifactPath, requireDictData } from './data-required';

requireDictData();

let store: SqliteDictStore;

beforeAll(async () => {
  store = new SqliteDictStore({ connect: async () => nodeRunner(dictArtifactPath()) });
  await store.open();
});

afterAll(async () => {
  await store.close();
});

/** The ids of every reading of a simplified word, first first — what the reader's token carries. */
async function readingsOf(word: string): Promise<string[]> {
  const { tokens } = await store.segment(word, { script: 'simp' });
  expect(tokens, `${word} did not segment as one word`).toHaveLength(1);
  return [...(tokens[0].entryIds ?? [])];
}

describe('the first reading of a common polyphone', () => {
  /** The audit's list, and the four the enumeration added that a beginner meets in week one. */
  const FIRST: [word: string, id: string][] = [
    ['说', '說|说[shuo1]'],
    ['要', '要|要[yao4]'],
    ['看', '看|看[kan4]'],
    ['吗', '嗎|吗[ma5]'],
    ['打', '打|打[da3]'],
    ['着', '著|着[zhe5]'],
    ['行', '行|行[xing2]'],
    ['重', '重|重[zhong4]'],
    ['几', '幾|几[ji3]'],
    ['差', '差|差[cha4]'],
    ['听', '聽|听[ting1]'],
    ['个', '個|个[ge4]'],
    ['吧', '吧|吧[ba5]'],
    ['多少', '多少|多少[duo1 shao5]'],
    // The band-5 jìn says only "see 儘可能…"; its band no longer counts.
    ['尽可能', '儘可能|尽可能[jin3 ke3 neng2]'],
    // Unchanged by the tie-break and recorded as defensible by the audit.
    ['得', '得|得[de2]'],
    ['觉', '覺|觉[jiao4]'],
  ];

  it.each(FIRST)('%s is %s', async (word, id) => {
    expect((await readingsOf(word))[0]).toBe(id);
  });

  it('ends 你想跟我一起去吗 on ma, not má', async () => {
    const { tokens } = await store.segment('你想跟我一起去吗');
    const last = tokens[tokens.length - 1];
    expect(last.text).toBe('吗');
    expect(last.entryIds?.[0]).toBe('嗎|吗[ma5]');
    const [entry] = await store.entries([last.entryIds![0]]);
    expect(entry.pinyinMarked).toBe('ma');
  });

  it('keeps every other reading, in the order the band gives them', async () => {
    // Reordered, never dropped: the sheet still offers kān, and zháo before zhāo.
    expect(await readingsOf('看')).toEqual(['看|看[kan4]', '看|看[kan1]']);
    expect(await readingsOf('着')).toEqual([
      '著|着[zhe5]',
      '著|着[zhao2]',
      '著|着[zhao1]',
      '著|着[zhuo2]',
    ]);
  });
});

describe('compareEntries', () => {
  const base: DictEntry = {
    id: '',
    simp: '吗',
    trad: '嗎',
    pinyinNum: '',
    pinyinMarked: '',
    glosses: [],
    classifiers: [],
    properNoun: false,
    isVariant: false,
    surname: false,
    freq: 100,
  };
  const entry = (id: string, extra: Partial<DictEntry> = {}): DictEntry => ({ ...base, id, ...extra });

  it('puts a banded reading before an unbanded one, and a lower band before a higher', () => {
    const unbanded = entry('嗎|吗[ma2]');
    const band6 = entry('嗎|吗[ma3]', { hskBand: 6 });
    const band1 = entry('嗎|吗[ma5]', { hskBand: 1 });
    expect([unbanded, band6, band1].sort(compareEntries).map((one) => one.id)).toEqual([
      '嗎|吗[ma5]',
      '嗎|吗[ma3]',
      '嗎|吗[ma2]',
    ]);
  });

  it('lets frequency, variant and proper noun outrank the band, as before', () => {
    const commoner = entry('b', { freq: 101 });
    const banded = entry('a', { hskBand: 1 });
    expect([banded, commoner].sort(compareEntries)[0].id).toBe('b');
    expect([entry('a', { hskBand: 1, isVariant: true }), entry('b')].sort(compareEntries)[0].id).toBe(
      'b',
    );
    expect(
      [entry('a', { hskBand: 1, properNoun: true }), entry('b')].sort(compareEntries)[0].id,
    ).toBe('b');
  });

  it('does not count the band of an entry whose every gloss is a cross-reference', () => {
    const pointer = entry('盡可能|尽可能[jin4 ke3 neng2]', {
      hskBand: 5,
      glosses: ['see 儘可能|尽可能[jin3 ke3 neng2]'],
    });
    const meaning = entry('儘可能|尽可能[jin3 ke3 neng2]', { glosses: ['as far as possible'] });
    expect([pointer, meaning].sort(compareEntries)[0].id).toBe(meaning.id);
    // One real gloss is enough to keep the band.
    const mixed = { ...pointer, glosses: [...pointer.glosses, 'to do one\'s utmost'] };
    expect([mixed, meaning].sort(compareEntries)[0].id).toBe(mixed.id);
  });

  it('recognises the cross-reference forms CC-CEDICT writes, and nothing that merely starts like one', () => {
    for (const gloss of [
      'see 儘可能|尽可能[jin3 ke3 neng2]',
      'see also 仿傚|仿效[fang3 xiao4]',
      'used in 似的[shi4 de5]',
      'variant of 家伙[jia1 huo5]',
      'old variant of 乾|干[gan1]',
      'erhua variant of 一點|一点[yi1 dian3]',
      '(Tw) see 秘魯|秘鲁[Bi4 lu3]',
    ]) {
      expect(isCrossReferenceOnly({ glosses: [gloss] }), gloss).toBe(true);
    }
    for (const gloss of [
      'seed',
      'seemingly; apparently',
      '(used after a verb) endlessly',
      '(used in the names of grand buildings)',
      'abbr. for 體格檢查|体格检查[ti3 ge2 jian3 cha2]',
      'equivalent to',
    ]) {
      expect(isCrossReferenceOnly({ glosses: [gloss] }), gloss).toBe(false);
    }
    expect(isCrossReferenceOnly({ glosses: [] })).toBe(false);
  });

  it('puts a preferred reading first, ahead of the band but not of frequency, variant or proper noun', () => {
    const preferred = entry('殼|壳[ke2]', { simp: '壳', trad: '殼' });
    const banded = entry('殼|壳[qiao4]', { simp: '壳', trad: '殼', hskBand: 7 });
    expect([banded, preferred].sort(compareEntries)[0].id).toBe(preferred.id);
    expect([{ ...preferred, freq: 99 }, banded].sort(compareEntries)[0].id).toBe(banded.id);
    expect([{ ...preferred, isVariant: true }, banded].sort(compareEntries)[0].id).toBe(banded.id);
    expect([{ ...preferred, properNoun: true }, banded].sort(compareEntries)[0].id).toBe(banded.id);
  });

  it('falls back to the id when the band ties too', () => {
    expect([entry('b', { hskBand: 2 }), entry('a', { hskBand: 2 })].sort(compareEntries)[0].id).toBe(
      'a',
    );
  });
});
