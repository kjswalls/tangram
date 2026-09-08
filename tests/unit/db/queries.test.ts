import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';

import { createDexieRepository, TangramDb } from '@/lib/db/dexie';
import type { Repository } from '@/lib/db/repository';
import { STABILITY_BUCKETS } from '@/lib/db/repository';
import {
  DEFAULT_SETTINGS,
  SETTINGS_ID,
  STORES_V2,
  type CardRow,
  type SettingsRow,
} from '@/lib/db/schema';
import { DASUAN, KANKAN, context, freshRepository } from './fixtures';

const DAY = 86_400_000;
const START = Date.UTC(2026, 2, 3, 9);

let counter = 0;
const open: { close: () => void }[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function repo(): Repository {
  const { db, repo: repository } = freshRepository();
  open.push(db);
  return repository;
}

/**
 * The read-only queries the retention dashboard and the FSRS optimizer both
 * need (Phase 8 prep). They live on the repository so that neither of those
 * writes Dexie access of its own — the seam is the whole reason a later
 * Supabase move is a swap (§3.3).
 */
describe('reviewsBetween', () => {
  it('returns the half-open window, oldest first', async () => {
    const repository = repo();
    const card = await repository.addCardFromEntry(DASUAN);
    for (const day of [0, 1, 2, 3]) {
      await repository.grade(card.id, 3, START + day * DAY);
    }

    const window = await repository.reviewsBetween(START + DAY, START + 3 * DAY);
    expect(window.map((row) => row.reviewedAt)).toEqual([START + DAY, START + 2 * DAY]);

    // Consecutive windows tile: the row on the boundary belongs to exactly one.
    const first = await repository.reviewsBetween(START, START + 2 * DAY);
    const second = await repository.reviewsBetween(START + 2 * DAY, START + 4 * DAY);
    expect(first.length + second.length).toBe(4);
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(4);
  });

  it('is empty for an empty or inverted window', async () => {
    const repository = repo();
    const card = await repository.addCardFromEntry(DASUAN);
    await repository.grade(card.id, 3, START);
    expect(await repository.reviewsBetween(START, START)).toEqual([]);
    expect(await repository.reviewsBetween(START + DAY, START)).toEqual([]);
  });
});

describe('allReviewsChronological', () => {
  it('is every review, across every card, ordered by when it happened', async () => {
    const repository = repo();
    const one = await repository.addCardFromEntry(DASUAN);
    const two = await repository.addCardFromEntry(KANKAN);

    // Written out of order on purpose: the optimizer trains on a chronology,
    // and the write order is not it.
    await repository.grade(two.id, 3, START + 2 * DAY);
    await repository.grade(one.id, 1, START);
    await repository.grade(one.id, 3, START + DAY);

    const rows = await repository.allReviewsChronological();
    expect(rows.map((row) => row.reviewedAt)).toEqual([START, START + DAY, START + 2 * DAY]);
    expect(rows.map((row) => row.cardId)).toEqual([one.id, one.id, two.id]);
    // Enough to replay from: the rating and the state it was in beforehand.
    expect(rows[0].rating).toBe(1);
    expect(rows[0].before.state).toBe(0);
  });

  it('is empty on a database nobody has reviewed in', async () => {
    expect(await repo().allReviewsChronological()).toEqual([]);
  });
});

describe('cardCountsByState', () => {
  it('counts the live cards by FSRS state, by name', async () => {
    const repository = repo();
    const one = await repository.addCardFromEntry(DASUAN);
    await repository.addCardFromEntry(KANKAN);

    expect(await repository.cardCountsByState()).toEqual({
      new: 2,
      learning: 0,
      review: 0,
      relearning: 0,
      total: 2,
    });

    // Good on a new card is a learning step (the default settings); Easy
    // graduates it to Review.
    await repository.grade(one.id, 3, START);
    expect((await repository.cardCountsByState()).learning).toBe(1);
    await repository.grade(one.id, 4, START + DAY);
    const counts = await repository.cardCountsByState();
    expect(counts.review).toBe(1);
    expect(counts.new).toBe(1);
    expect(counts.total).toBe(2);
  });
});

describe('stabilityHistogram', () => {
  it('buckets reviewed cards and leaves the unstudied ones out', async () => {
    const repository = repo();
    const card = await repository.addCardFromEntry(DASUAN);
    await repository.addCardFromEntry(KANKAN);

    const empty = await repository.stabilityHistogram();
    expect(empty.map((bucket) => bucket.label)).toEqual(
      STABILITY_BUCKETS.map((bucket) => bucket.label),
    );
    // Two New cards, and a New card's stability is a placeholder.
    expect(empty.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(0);

    await repository.grade(card.id, 4, START);
    const after = await repository.stabilityHistogram();
    expect(after.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(1);

    // The bars sum to every card that is not New.
    const counts = await repository.cardCountsByState();
    expect(after.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(counts.total - counts.new);
  });

  it('puts a "mark known" card in the top bucket', async () => {
    const repository = repo();
    await repository.addCardFromEntry(DASUAN);
    await repository.markKnown([DASUAN.id]);
    const buckets = await repository.stabilityHistogram();
    expect(buckets[buckets.length - 1].label).toBe('1y+');
    expect(buckets[buckets.length - 1].count).toBe(1);
  });
});

/**
 * A card is identified by its direction as well as its entry and sense
 * (`CardDirection`, Dexie v3): the production card for a word is a different
 * card with its own schedule, and the two must not find each other.
 */
describe('cards per direction', () => {
  it('defaults to recognition, so every existing caller keeps its card', async () => {
    const repository = repo();
    const card = await repository.addCardFromEntry(DASUAN, context({ source: 'lookup' }));
    expect(card.direction).toBe('recognition');
    expect((await repository.cardForEntry(DASUAN.id))?.id).toBe(card.id);
    expect((await repository.cardForEntry(DASUAN.id, undefined, 'recognition'))?.id).toBe(card.id);
    expect(await repository.cardForEntry(DASUAN.id, undefined, 'production')).toBeUndefined();
  });

  it('makes a second, separate card for the other direction', async () => {
    const repository = repo();
    const recognition = await repository.addCardFromEntry(DASUAN);
    const production = await repository.addCardFromEntry(
      DASUAN,
      undefined,
      undefined,
      undefined,
      'production',
    );
    expect(production.id).not.toBe(recognition.id);
    expect(production.direction).toBe('production');
    // One word row behind both: the entry is the same word either way round.
    expect(production.wordId).toBe(recognition.wordId);

    // Still idempotent per (entry, sense, direction).
    const again = await repository.addCardFromEntry(
      DASUAN,
      undefined,
      undefined,
      undefined,
      'production',
    );
    expect(again.id).toBe(production.id);
    expect((await repository.allCards()).length).toBe(2);

    // And grading one leaves the other where it was.
    await repository.grade(production.id, 4, START);
    expect((await repository.cardForEntry(DASUAN.id))?.fsrs.state).toBe(0);
    expect((await repository.cardForEntry(DASUAN.id, undefined, 'production'))?.fsrs.state).toBe(2);
  });
});

describe('a settings row written by an older build', () => {
  it('reads back with the new columns filled in, and is written back once', async () => {
    const { db, repo: repository } = freshRepository();
    open.push(db);

    // Exactly what Phase 7 stored: no retention, no steps flag, no weights.
    const legacy = {
      id: SETTINGS_ID,
      newPerDay: 7,
      spineStartBand: 3,
      knownBand: 2,
      dayRollover: 4,
      script: 'simp',
      provider: 'fake',
      introduced: { '2026-03-02': 4 },
      createdAt: 1,
      updatedAt: 2,
    } as unknown as SettingsRow;
    await db.settings.put(legacy);

    const settings = await repository.getSettings();
    // The learner's own choices survive; the new columns arrive at their
    // defaults rather than as `undefined`.
    expect(settings.newPerDay).toBe(7);
    expect(settings.introduced).toEqual({ '2026-03-02': 4 });
    expect(settings.requestRetention).toBe(DEFAULT_SETTINGS.requestRetention);
    expect(settings.shortTermSteps).toBe(true);
    expect(settings.productionDirection).toBe(false);
    expect(settings.fsrsWeights).toBeNull();

    const stored = await db.settings.get(SETTINGS_ID);
    expect(stored?.requestRetention).toBe(DEFAULT_SETTINGS.requestRetention);
    expect(stored?.newPerDay).toBe(7);
  });
});

/**
 * There is real data on a phone, so the v3 migration has one job beyond adding
 * the index: lose nothing.
 */
describe('a database written before the direction index existed', () => {
  it('upgrades to v3 keeping every row, and answers the new query', async () => {
    const name = `tangram-v2-${Date.now()}-${counter++}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores(STORES_V2);
    open.push(legacy);

    const base = {
      wordId: 'word-1',
      kind: 'word' as const,
      snapshot: {
        simp: '打算',
        trad: '打算',
        pinyinMarked: 'dǎsuàn',
        pinyinNum: 'da3 suan4',
        glosses: ['to plan'],
        classifiers: [],
        dictVersion: 'test',
      },
      fsrs: {
        state: 2 as const,
        due: START + DAY,
        stability: 30,
        difficulty: 5,
        reps: 3,
        lapses: 0,
        scheduled_days: 30,
        learning_steps: 0,
      },
      due: START + DAY,
      createdAt: 1,
      updatedAt: 2,
      deletedAt: null,
    };
    await legacy.table<CardRow, string>('cards').bulkAdd([
      { ...base, id: 'stamped', entryId: DASUAN.id, direction: 'recognition' },
      // A row from a build that predates the column entirely: it must not be
      // dropped, and it must not be invisible to the compound index.
      { ...base, id: 'unstamped', entryId: KANKAN.id } as unknown as CardRow,
    ]);
    await legacy
      .table('reviews')
      .add({ id: 'r1', cardId: 'stamped', rating: 3, reviewedAt: START, before: base.fsrs, log: {}, createdAt: START });
    legacy.close();

    const db = new TangramDb(name);
    open.push(db);
    const repository = createDexieRepository(db);

    expect(db.verno).toBe(3);
    expect((await repository.allCards()).map((row) => row.id).sort()).toEqual([
      'stamped',
      'unstamped',
    ]);
    expect((await repository.allReviewsChronological()).map((row) => row.id)).toEqual(['r1']);

    // Both rows answer a per-direction lookup — the second one because the
    // upgrade stamped the default onto it.
    expect((await repository.cardForEntry(DASUAN.id))?.id).toBe('stamped');
    expect((await repository.cardForEntry(KANKAN.id))?.id).toBe('unstamped');
    expect((await db.cards.get('unstamped'))?.direction).toBe('recognition');
  });
});
