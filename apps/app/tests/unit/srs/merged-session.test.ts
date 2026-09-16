/**
 * One session (docs/plans/core.md C7; `wave-zero.md` §9).
 *
 * product-decisions §1's central claim is that learning a new word, recognising
 * it and writing it are **one** session. C7's unit criterion names the three
 * properties that a merge could quietly reintroduce as bugs, "because a merge
 * that quietly re-charges the cap is indistinguishable from a working one until
 * the second day":
 *
 *   1. the introduction charge stays at **card creation**, not at grading;
 *   2. the cap is still the **day's** cap, whoever asks for the cards;
 *   3. nothing about FSRS changes.
 *
 * The first two are asserted here against a real repository; the third is
 * asserted by construction — `interleaveNew` is a pure reordering and this file
 * proves it returns the same multiset it was given.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import type { CardRow } from '@/lib/db/schema';
import { loadToday } from '@/lib/lists/today';
import { interleaveNew } from '@/lib/srs/session';
import { todayKey } from '@/lib/srs/day';
import type { Entry, EntryId } from '@/lib/types';

/** A card-shaped stub: only what `interleaveNew` reads, which is nothing. */
function card(id: string): CardRow {
  return { id } as unknown as CardRow;
}

const ids = (cards: readonly CardRow[]) => cards.map((row) => row.id);

describe('interleaveNew', () => {
  it('spreads the new words through the due ones', () => {
    const due = [card('d1'), card('d2'), card('d3'), card('d4'), card('d5'), card('d6')];
    const fresh = [card('n1'), card('n2')];
    const merged = ids(interleaveNew(due, fresh));

    // Every card, once, and no invention.
    expect([...merged].sort()).toEqual([...ids(due), ...ids(fresh)].sort());
    // …and they are not a block at either end, which is what the queue did
    // before: `[...due, ...newCards]`.
    expect(merged.at(0)).toBe('d1');
    expect(merged.indexOf('n1')).toBeGreaterThan(0);
    expect(merged.indexOf('n1')).toBeLessThan(merged.length - 1);
    expect(merged.indexOf('n2')).toBeGreaterThan(merged.indexOf('n1'));
  });

  it('opens on a review, never on a word the learner has never seen', () => {
    // Opening Practice to something new reads as the app ignoring the work you
    // have waiting.
    const merged = ids(interleaveNew([card('d1')], [card('n1'), card('n2'), card('n3')]));
    expect(merged[0]).toBe('d1');
  });

  it('keeps the due order and the new order', () => {
    const due = [card('d1'), card('d2'), card('d3')];
    const fresh = [card('n1'), card('n2')];
    const merged = ids(interleaveNew(due, fresh));
    expect(merged.filter((id) => id.startsWith('d'))).toEqual(['d1', 'd2', 'd3']);
    expect(merged.filter((id) => id.startsWith('n'))).toEqual(['n1', 'n2']);
  });

  it('handles the two degenerate sessions without dropping anything', () => {
    expect(ids(interleaveNew([card('d1')], []))).toEqual(['d1']);
    expect(ids(interleaveNew([], [card('n1')]))).toEqual(['n1']);
    expect(ids(interleaveNew([], []))).toEqual([]);
  });

  it('never loses a new word, however lopsided the session', () => {
    for (const [d, n] of [
      [0, 5],
      [1, 5],
      [5, 1],
      [20, 3],
      [3, 20],
      [1, 1],
    ]) {
      const due = Array.from({ length: d }, (_, i) => card(`d${i}`));
      const fresh = Array.from({ length: n }, (_, i) => card(`n${i}`));
      const merged = interleaveNew(due, fresh);
      expect(merged, `${d} due / ${n} new`).toHaveLength(d + n);
      expect(new Set(ids(merged)).size).toBe(d + n);
    }
  });
});

/** A dictionary the draw can read, with no network and no `data/` build. */
function entrySource(count: number) {
  const entries: Entry[] = Array.from({ length: count }, (_, index) => ({
    id: `词${index}|词${index}[ci2 ${index}]` as EntryId,
    simp: `词${index}`,
    trad: `詞${index}`,
    pinyinNum: `ci2 ${index}`,
    pinyinMarked: `cí ${index}`,
    glosses: [`word ${index}`],
    classifiers: [],
    properNoun: false,
    isVariant: false,
    surname: false,
    // Band 2: the spine skips any band at or below `settings.knownBand`, and
    // the settings below assume band 1 is already known.
    hskBand: 2,
    freq: 1000 - index,
  }));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    band: async () => entries,
    entries: async (wanted: readonly EntryId[]) =>
      wanted.map((id) => byId.get(id)).filter((entry): entry is Entry => entry !== undefined),
    search: async () => [],
    dictVersion: () => 'test',
  };
}

describe('the merged session’s three non-negotiables', () => {
  beforeEach(async () => {
    await getDb().delete();
    await closeDb();
  });

  it('charges the day’s counter at card CREATION, not at grading', async () => {
    const repo = getRepository();
    await repo.setSettings({ newPerDay: 3, knownBand: 1, spineStartBand: 2 });
    const now = Date.UTC(2026, 8, 16, 9);
    const source = entrySource(20) as never;

    const summary = await loadToday({ repo, now, source });
    expect(summary.created).toHaveLength(3);

    // The counter is up before a single card has been graded — which is what
    // makes "see ten new words, close the tab" cost the day's ten.
    const settings = await repo.getSettings();
    const key = todayKey(now, settings.dayRollover);
    expect(settings.introduced[key]).toBe(3);
  });

  it('…and a second pass hands out nothing further, cards graded or not', async () => {
    const repo = getRepository();
    await repo.setSettings({ newPerDay: 3, knownBand: 1, spineStartBand: 2 });
    const now = Date.UTC(2026, 8, 16, 9);
    const source = entrySource(20) as never;

    await loadToday({ repo, now, source });
    const again = await loadToday({ repo, now, source });
    expect(again.created).toHaveLength(0);
    expect(await repo.allCards()).toHaveLength(3);

    // Grading them does not hand the allowance back (the bug charging at
    // creation exists to prevent).
    for (const row of await repo.allCards()) await repo.grade(row.id, 3);
    const third = await loadToday({ repo, now: now + 60_000, source });
    expect(third.created).toHaveLength(0);
    expect(await repo.allCards()).toHaveLength(3);
  });

  it('reports what the session will offer WITHOUT creating it', async () => {
    // The half C7 moved: Today reports, Practice introduces. A screen that
    // reported by creating is what made opening the app spend the day's ten.
    const repo = getRepository();
    await repo.setSettings({ newPerDay: 4, knownBand: 1, spineStartBand: 2 });
    const now = Date.UTC(2026, 8, 16, 9);
    const source = entrySource(20) as never;

    const reported = await loadToday({ repo, now, source, introduce: false });
    expect(reported.newAvailable).toBe(4);
    expect(reported.created).toHaveLength(0);
    expect(await repo.allCards()).toHaveLength(0);

    // …and the number it reported is the number the session then creates.
    const session = await loadToday({ repo, now, source });
    expect(session.created).toHaveLength(4);
    expect(session.newAvailable).toBe(4);
  });
});
