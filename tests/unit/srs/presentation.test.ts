import { describe, expect, it } from 'vitest';

import type { CardRow, EntrySnapshot, PhraseSnapshot } from '@/lib/db/schema';
import { cardBack, cardFace, cardTargetText, orderGlosses } from '@/lib/srs/presentation';

const SIMPLE: EntrySnapshot = {
  simp: '打算',
  trad: '打算',
  pinyinMarked: 'dǎsuàn',
  pinyinNum: 'da3 suan4',
  glosses: ['to plan', 'to intend', 'to calculate'],
  classifiers: ['个'],
  hskBand: 2,
  dictVersion: 'test',
};

const SPLIT: EntrySnapshot = {
  ...SIMPLE,
  simp: '书',
  trad: '書',
  pinyinMarked: 'shū',
  pinyinNum: 'shu1',
  glosses: ['book'],
  classifiers: ['本'],
  hskBand: 1,
};

const PHRASE: PhraseSnapshot = {
  tokens: [{ text: '我' }, { text: '随便', entryId: 'x' }],
  simp: '我随便看看',
  pinyinMarked: 'wǒ suíbiàn kànkan',
  en: "I'm just browsing",
  dictVersion: 'test',
};

describe('cardFace', () => {
  it('shows one form when the two scripts agree', () => {
    expect(cardFace(SIMPLE, 'simp')).toEqual({ primary: '打算' });
  });

  it('shows the other script alongside when they differ', () => {
    expect(cardFace(SPLIT, 'simp')).toEqual({
      primary: '书',
      secondary: '書',
      secondaryLabel: 'Traditional',
    });
  });

  it('leads with traditional when that is the setting', () => {
    expect(cardFace(SPLIT, 'trad')).toEqual({
      primary: '書',
      secondary: '书',
      secondaryLabel: 'Simplified',
    });
  });

  it('renders a phrase card from its rendered form', () => {
    expect(cardFace(PHRASE, 'simp')).toEqual({ primary: '我随便看看' });
    expect(cardTargetText(PHRASE, 'simp')).toBe('我随便看看');
  });
});

describe('orderGlosses', () => {
  it('keeps the entry’s order when no sense was chosen', () => {
    expect(orderGlosses(SIMPLE.glosses)).toEqual({
      chosen: ['to plan', 'to intend', 'to calculate'],
      others: [],
    });
  });

  it('leads with the chosen sense and folds the rest away', () => {
    expect(orderGlosses(SIMPLE.glosses, 1)).toEqual({
      chosen: ['to intend'],
      others: ['to plan', 'to calculate'],
    });
  });

  it('ignores an out-of-range sense rather than showing nothing', () => {
    expect(orderGlosses(SIMPLE.glosses, 9).chosen).toHaveLength(3);
    expect(orderGlosses(SIMPLE.glosses, -1).chosen).toHaveLength(3);
  });
});

describe('cardBack', () => {
  const card = (patch: Partial<CardRow> = {}) =>
    ({ snapshot: SIMPLE, ...patch }) as Pick<CardRow, 'snapshot' | 'senseIndex'>;

  it('carries the reading, the senses, the classifiers and the band', () => {
    const back = cardBack(card());
    expect(back.pinyinMarked).toBe('dǎsuàn');
    expect(back.glosses.chosen).toHaveLength(3);
    expect(back.classifiers).toEqual(['个']);
    expect(back.hskLabel).toBe('HSK 2');
  });

  it('labels band 7 as 7–9', () => {
    expect(cardBack(card({ snapshot: { ...SIMPLE, hskBand: 7 } })).hskLabel).toBe('HSK 7–9');
  });

  it('has no band line for an unbanded word', () => {
    const back = cardBack(card({ snapshot: { ...SIMPLE, hskBand: undefined } }));
    expect(back.hskLabel).toBeUndefined();
  });

  it('answers a phrase card with its English, not with glosses', () => {
    const back = cardBack(card({ snapshot: PHRASE }));
    expect(back.en).toBe("I'm just browsing");
    expect(back.glosses).toEqual({ chosen: [], others: [] });
  });
});
