import { afterEach, describe, expect, it } from 'vitest';

import { buildLearnerProfile, getLearnerProfile } from '@/lib/srs/profile';
import type { CardRow, SettingsRow } from '@/lib/db/schema';
import { newCard } from '@/lib/srs/card';
import { DASUAN, freshRepository, KANKAN } from '../db/fixtures';

let close: (() => void) | undefined;

afterEach(() => {
  close?.();
  close = undefined;
});

const settings = { knownBand: 2 } as Pick<SettingsRow, 'knownBand'>;

function wordCard(
  simp: string,
  hskBand: number | undefined,
  stability: number,
  freqRank?: number,
): CardRow {
  const now = Date.now();
  return {
    id: `card-${simp}`,
    wordId: `word-${simp}`,
    entryId: `${simp}|${simp}[x]`,
    kind: 'word',
    direction: 'recognition',
    snapshot: {
      simp,
      trad: simp,
      pinyinMarked: '',
      pinyinNum: '',
      glosses: [],
      classifiers: [],
      ...(hskBand === undefined ? {} : { hskBand: hskBand as 1 }),
      ...(freqRank === undefined ? {} : { freqRank }),
      dictVersion: 'test',
    },
    fsrs: { ...newCard(now), state: 2, stability },
    due: now,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

describe('buildLearnerProfile', () => {
  it('falls back to the known band when no band sizes are supplied', () => {
    const profile = buildLearnerProfile({ settings, cards: [], known: [] });
    expect(profile.estimatedBand).toBe(2);
    expect(profile.knownSample).toEqual([]);
  });

  it('samples words that are known or learning, never untouched ones', () => {
    const profile = buildLearnerProfile({
      settings,
      cards: [wordCard('打算', 2, 100), wordCard('起源', 6, 1)],
      known: [{ entryId: '太陽|太阳[tai4 yang2]' }],
    });
    expect(profile.knownSample).toContain('打算');
    expect(profile.knownSample).toContain('起源');
    // A word declared known without a card still has a recoverable headword.
    expect(profile.knownSample).toContain('太阳');
  });

  it('orders the sample by frequency, which is what survives the 200 cut', () => {
    // §3.3 asks for a freq-ordered sample; the truncation happens here, in the
    // browser, so a server-side re-sort would already have lost the right words.
    const profile = buildLearnerProfile({
      settings,
      cards: [
        wordCard('起源', 6, 100, 9000),
        wordCard('打算', 2, 100, 1200),
        wordCard('的', 1, 100, 1),
        wordCard('无', undefined, 100),
      ],
      known: [],
    });
    expect(profile.knownSample).toEqual(['的', '打算', '起源', '无']);
  });

  it('raises the estimate to the highest band with 80% coverage', () => {
    const cards = ['a', 'b', 'c', 'd'].map((simp) => wordCard(simp, 3, 100));
    const profile = buildLearnerProfile({
      settings,
      cards,
      known: [],
      bandSizes: { 1: 500, 2: 700, 3: 5, 4: 900 },
    });
    expect(profile.estimatedBand).toBe(3);
  });

  it('leaves the estimate alone when a band is only half covered', () => {
    const profile = buildLearnerProfile({
      settings,
      cards: [wordCard('a', 3, 100)],
      known: [],
      bandSizes: { 3: 10 },
    });
    expect(profile.estimatedBand).toBe(2);
  });
});

describe('getLearnerProfile', () => {
  it('reads settings, known words and cards through the repository', async () => {
    const { db, repo } = freshRepository();
    close = () => db.close();

    const card = await repo.addCardFromEntry(DASUAN);
    await repo.grade(card.id, 3, Date.now());
    await repo.markKnown([KANKAN.id]);

    const profile = await getLearnerProfile(repo);
    expect(profile.estimatedBand).toBe(2);
    expect(profile.knownSample).toContain('打算');
    expect(profile.knownSample.length).toBeLessThanOrEqual(200);
  });
});
