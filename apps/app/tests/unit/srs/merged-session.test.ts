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
import { emptyStateMessage, interleaveNew } from '@/lib/srs/session';
import { todayKey } from '@/lib/srs/day';
import type { Entry, EntryId } from '@/lib/types';

/** A card-shaped stub: only what `interleaveNew` reads, which is nothing. */
function card(id: string): CardRow {
  return { id } as unknown as CardRow;
}

const ids = (cards: readonly CardRow[]) => cards.map((row) => row.id);

/**
 * The session as the store actually runs it: rebuild the queue after every
 * grade, take `queue[0]`, repeat.
 *
 * This is the shape the first version of the merge did not survive. It is a
 * simulation rather than a mock of the store because the store's own loop is
 * three lines (`load()` → `queue[0]` → `grade()` → `load()`), and what is being
 * tested is the *ordering rule*, not zustand.
 */
function serveWholeSession(dueCount: number, freshCount: number): string[] {
  let due = Array.from({ length: dueCount }, (_, index) => card(`d${index}`));
  let fresh = Array.from({ length: freshCount }, (_, index) => card(`n${index}`));
  const served: string[] = [];
  const counts = { due: 0, fresh: 0 };
  while (due.length + fresh.length > 0) {
    const next = interleaveNew(due, fresh, counts)[0];
    served.push(next.id);
    if (next.id.startsWith('d')) {
      due = due.filter((row) => row.id !== next.id);
      counts.due += 1;
    } else {
      fresh = fresh.filter((row) => row.id !== next.id);
      counts.fresh += 1;
    }
  }
  return served;
}

describe('the session as it is actually served', () => {
  it('reaches a new word early, not after every review', () => {
    // **The regression this test exists for.** Without `served`, the rebuild
    // after each grade re-spread the *remaining* new words through the
    // *remaining* reviews, so the first new word stayed about
    // `remainingDue / remainingNew` places away and the order actually served
    // was `d0…d14 n0…n4` — the very `[...due, ...newCards]` the merge replaces.
    const served = serveWholeSession(15, 5);
    const first = served.findIndex((id) => id.startsWith('n'));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(served, 'first new word too late').toHaveLength(20);
    expect(first, `served: ${served.join(' ')}`).toBeLessThan(6);
  });

  it('spreads them, rather than moving the block from the end to the front', () => {
    const served = serveWholeSession(15, 5);
    const positions = served
      .map((id, index) => ({ id, index }))
      .filter((row) => row.id.startsWith('n'))
      .map((row) => row.index);
    // Five new words over twenty items, spread: one in each third of the
    // session and never two in a row. The *last* one landing at the very end is
    // the design — "the last new word lands near the end rather than in the
    // middle" — so it is not a failure here.
    expect(positions).toHaveLength(5);
    const third = served.length / 3;
    expect(positions.some((at) => at < third), `early: ${positions.join(',')}`).toBe(true);
    expect(positions.some((at) => at >= 2 * third), `late: ${positions.join(',')}`).toBe(true);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i] - positions[i - 1], `adjacent at ${positions.join(',')}`).toBeGreaterThan(1);
    }
  });

  it('opens on a review and serves every card exactly once, at any mix', () => {
    for (const [d, n] of [
      [15, 5],
      [3, 1],
      [1, 5],
      [20, 3],
      [5, 5],
      [1, 1],
    ] as const) {
      const served = serveWholeSession(d, n);
      expect(served, `${d}/${n}`).toHaveLength(d + n);
      expect(new Set(served).size, `${d}/${n}`).toBe(d + n);
      if (d > 0) expect(served[0], `${d}/${n} opened on a new word`).toMatch(/^d/);
    }
  });
});

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

  it('never lets a reporting load satisfy the session’s introducing one', async () => {
    /**
     * The path is "Start practice": Today's own `loadToday({introduce: false})`
     * is still in flight when the Practice tab mounts and calls the
     * introducing one. Keyed on the repository alone, the session took the
     * reporting promise — and came back having created nothing, on a day whose
     * cap was untouched. The learner sees "5 new words to learn" and a session
     * with none in it.
     */
    const repo = getRepository();
    await repo.setSettings({ newPerDay: 4, knownBand: 1, spineStartBand: 2 });
    const now = Date.UTC(2026, 8, 16, 9);
    const source = entrySource(20) as never;

    const reporting = loadToday({ repo, now, source, introduce: false });
    const session = loadToday({ repo, now, source });
    // Not the same promise: the session runs its own.
    expect(session).not.toBe(reporting);

    const [reported, introduced] = await Promise.all([reporting, session]);
    expect(reported.created).toHaveLength(0);
    expect(introduced.created).toHaveLength(4);
    expect(await repo.allCards()).toHaveLength(4);

    // …and the other direction is still deduped, because a reporting caller is
    // happy with an introducing run's answer.
    const second = loadToday({ repo, now, source });
    const alongside = loadToday({ repo, now, source, introduce: false });
    expect(alongside).toBe(second);
    await Promise.all([second, alongside]);

    // The cap was charged once, not twice.
    const settings = await repo.getSettings();
    expect(settings.introduced[todayKey(now, settings.dayRollover)]).toBe(4);
    expect(await repo.allCards()).toHaveLength(4);
  });

  it('reports only what the spine can actually supply, and says when it cannot', async () => {
    /**
     * `newToOffer` used to be `newCards.length + drawLimit` — the day's
     * *allowance*, not the day's *inventory*. A learner whose spine is
     * exhausted read "10 new words to learn" on Today every day over a session
     * that introduced none, and Today's own "No new words could be drawn"
     * banner could never fire because the reporting path never attempted a
     * draw. Both halves are this test.
     */
    const repo = getRepository();
    await repo.setSettings({ newPerDay: 10, knownBand: 1, spineStartBand: 2 });
    const now = Date.UTC(2026, 8, 16, 9);

    // Three words in the whole spine, against a cap of ten.
    const thin = entrySource(3) as never;
    const reported = await loadToday({ repo, now, source: thin, introduce: false });
    expect(reported.newToOffer).toBe(3);
    expect(reported.created).toHaveLength(0);
    expect(await repo.allCards()).toHaveLength(0);

    // …and the session hands out exactly that.
    const session = await loadToday({ repo, now, source: thin });
    expect(session.created).toHaveLength(3);
    expect(session.newToOffer).toBe(3);
  });

  it('reports a dictionary outage rather than a number it cannot honour', async () => {
    const repo = getRepository();
    await repo.setSettings({ newPerDay: 10, knownBand: 1, spineStartBand: 2 });
    const now = Date.UTC(2026, 8, 16, 9);
    const broken = {
      band: async () => {
        throw new Error('dict-data-missing');
      },
      entries: async () => [],
      search: async () => [],
      dictVersion: () => 'test',
    } as never;

    const reported = await loadToday({ repo, now, source: broken, introduce: false });
    // The banner, on the screen that reports — it used to be unreachable there.
    expect(reported.drawError).toContain('dict-data-missing');
    expect(reported.created).toHaveLength(0);
    // Missing data is a banner, not a crash (CLAUDE.md): everything else is
    // still true and nothing threw.
    expect(reported.dueCount).toBe(0);
    /**
     * **And the number the banner sits under is 0, not the cap.**
     *
     * `drawable` stayed `undefined` on the catch path, and `newToOffer` read
     * `undefined` as "report the whole allowance" — so Today said "10 new words
     * to learn. About one minute." directly above "No new words could be
     * drawn", with "Start practice" enabled over a session that would introduce
     * none. That is the allowance-for-inventory bug the field was written to
     * remove, surviving in the one state nobody asserted. Found by C8's
     * adversarial review.
     */
    expect(reported.newToOffer).toBe(0);
  });

  it('retries the spine after an outage, but does not re-walk it after a good read', async () => {
    /**
     * C7 moved the collection onto the reporting path so Today could say a true
     * number. The collector stops as soon as it has `limit` candidates, so an
     * ordinary day costs one window — but the day it *cannot* fill the cap it
     * has to page every active band to its end to find that out, and reporting
     * never charges the counter, so the walk repeated on every mount of the
     * Look up tab forever. The answer is remembered against the inputs that
     * decide it.
     */
    const repo = getRepository();
    await repo.setSettings({ newPerDay: 10, knownBand: 1, spineStartBand: 2 });
    const now = Date.UTC(2026, 8, 16, 9);

    let bandReads = 0;
    const thin = entrySource(3);
    const counted = {
      ...thin,
      band: async (...args: Parameters<typeof thin.band>) => {
        bandReads += 1;
        return thin.band(...args);
      },
    } as never;

    const first = await loadToday({ repo, now, source: counted, introduce: false });
    expect(first.newToOffer).toBe(3);
    const afterFirst = bandReads;
    expect(afterFirst).toBeGreaterThan(0);

    // Same day, same cards, same lists, same settings: the same answer, unread.
    const second = await loadToday({ repo, now, source: counted, introduce: false });
    expect(second.newToOffer).toBe(3);
    expect(bandReads).toBe(afterFirst);

    // A setting that moves the draw invalidates it — nothing is remembered past
    // the inputs it was measured against.
    await repo.setSettings({ newPerDay: 4 });
    const third = await loadToday({ repo, now, source: counted, introduce: false });
    expect(third.newToOffer).toBe(3);
    expect(bandReads).toBeGreaterThan(afterFirst);
  });

  it('does not remember an outage: the next mount asks again', async () => {
    const repo = getRepository();
    await repo.setSettings({ newPerDay: 10, knownBand: 1, spineStartBand: 2 });
    const now = Date.UTC(2026, 8, 16, 9);
    let down = true;
    const healthy = entrySource(3);
    const flaky = {
      ...healthy,
      band: async (...args: Parameters<typeof healthy.band>) => {
        if (down) throw new Error('dict-data-missing');
        return healthy.band(...args);
      },
    } as never;

    const outage = await loadToday({ repo, now, source: flaky, introduce: false });
    expect(outage.drawError).toContain('dict-data-missing');
    expect(outage.newToOffer).toBe(0);

    down = false;
    const recovered = await loadToday({ repo, now, source: flaky, introduce: false });
    expect(recovered.drawError).toBeUndefined();
    expect(recovered.newToOffer).toBe(3);
  });

  it('tells the session how many new words an outage is holding', async () => {
    /**
     * `emptyStateMessage`'s `waiting > 0` branch — "N new words are waiting,
     * once the dictionary is back" — was dead code: the store fed it
     * `queue.draws.length`, and `today.ts` never passes `newCandidates` to
     * `buildQueue`, so `draws` is always `[]`. During an outage the learner got
     * "look a word up and it joins your next session" instead, which is advice
     * the missing dictionary makes impossible to follow. Found by C8's
     * adversarial review; the store now derives it from the cap and the error.
     */
    const repo = getRepository();
    await repo.setSettings({ newPerDay: 7, knownBand: 1, spineStartBand: 2 });
    const now = Date.UTC(2026, 8, 16, 9);
    const broken = {
      band: async () => {
        throw new Error('dict-data-missing');
      },
      entries: async () => [],
      search: async () => [],
      dictVersion: () => 'test',
    } as never;

    const summary = await loadToday({ repo, now, source: broken });
    expect(summary.drawError).toContain('dict-data-missing');
    // The two the store reads: the cap still allows seven, and nothing was
    // created, so seven is what is being held.
    expect(summary.queue.drawLimit).toBe(7);
    expect(summary.created).toHaveLength(0);
    expect(
      emptyStateMessage({ next: null, now, waiting: summary.queue.drawLimit }),
    ).toBe('All done — 7 new words are waiting, once the dictionary is back.');

    // …and with no outage the same call reports nothing held, so the branch
    // cannot fire on a working day.
    const fine = await loadToday({ repo, now, source: entrySource(20) as never });
    expect(fine.drawError).toBeUndefined();
  });

  it('reports what the session will offer WITHOUT creating it', async () => {
    // The half C7 moved: Today reports, Practice introduces. A screen that
    // reported by creating is what made opening the app spend the day's ten.
    const repo = getRepository();
    await repo.setSettings({ newPerDay: 4, knownBand: 1, spineStartBand: 2 });
    const now = Date.UTC(2026, 8, 16, 9);
    const source = entrySource(20) as never;

    const reported = await loadToday({ repo, now, source, introduce: false });
    expect(reported.newToOffer).toBe(4);
    expect(reported.created).toHaveLength(0);
    expect(await repo.allCards()).toHaveLength(0);

    // …and the number it reported is the number the session then creates.
    const session = await loadToday({ repo, now, source });
    expect(session.created).toHaveLength(4);
    expect(session.newToOffer).toBe(4);
  });
});
