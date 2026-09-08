/**
 * Two directions, two memories (Phase 8, builder B) — against a real database.
 *
 * The claim this file exists to prove is the one the whole feature rests on:
 * **grading one direction does not move the other.** They are separate `cards`
 * rows with separate FSRS states, so nothing has to coordinate them; what could
 * still go wrong is a lookup that confuses the two, and that is checked here as
 * well (`cardForEntry`, and the idempotency of a second Add).
 *
 * The rest is the cap. A production twin is a new card and costs what a new
 * card costs: turning the setting on introduces nothing by itself, and the bulk
 * path never creates more than the day's remaining allowance.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { TangramDb } from '@/lib/db/dexie';
import type { Repository } from '@/lib/db/repository';
import { loadToday } from '@/lib/lists/today';
import { todayKey } from '@/lib/srs/day';
import { addProductionTwins, entryFromSnapshot, wordSnapshot } from '@/lib/srs/direction';
import { context, DASUAN, freshRepository, KANKAN } from '../db/fixtures';
import { fakeEntrySource } from '../lists/helpers';

const NOW = new Date(2026, 8, 7, 12).getTime();
const DAY = 86_400_000;

let open: TangramDb[] = [];

afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

function setup(): Repository {
  const { db, repo } = freshRepository();
  open.push(db);
  return repo;
}

/** The recognition card for an entry, plus its production twin. */
async function pair(repo: Repository) {
  const recognition = await repo.addCardFromEntry(DASUAN, context(), undefined, 'test');
  const snapshot = wordSnapshot(recognition.snapshot);
  const production = await repo.addCardFromEntry(
    entryFromSnapshot(recognition.entryId!, snapshot!),
    context(),
    undefined,
    'test',
    'production',
  );
  return { recognition, production };
}

describe('a word asked both ways round', () => {
  it('is two rows over one word, with two schedules', async () => {
    const repo = setup();
    const { recognition, production } = await pair(repo);

    expect(production.id).not.toBe(recognition.id);
    // One word row: the same word, asked the other way round.
    expect(production.wordId).toBe(recognition.wordId);
    expect(production.direction).toBe('production');
    expect(recognition.direction).toBe('recognition');
    expect(await repo.allCards()).toHaveLength(2);
  });

  it('answers a per-direction lookup without ever crossing over', async () => {
    const repo = setup();
    const { recognition, production } = await pair(repo);
    const id = recognition.entryId!;

    expect((await repo.cardForEntry(id))?.id).toBe(recognition.id);
    expect((await repo.cardForEntry(id, undefined, 'recognition'))?.id).toBe(recognition.id);
    expect((await repo.cardForEntry(id, undefined, 'production'))?.id).toBe(production.id);
  });

  it('makes no second twin when the same add runs twice', async () => {
    const repo = setup();
    const { production } = await pair(repo);
    const again = await repo.addCardFromEntry(
      entryFromSnapshot(production.entryId!, wordSnapshot(production.snapshot)!),
      context(),
      undefined,
      'test',
      'production',
    );
    expect(again.id).toBe(production.id);
    expect(await repo.allCards()).toHaveLength(2);
  });

  it('schedules each direction on its own: grading one does not move the other', async () => {
    const repo = setup();
    const { recognition, production } = await pair(repo);

    // Both start where a new card starts.
    expect(recognition.fsrs.state).toBe(0);
    expect(production.fsrs.state).toBe(0);

    await repo.grade(production.id, 4, NOW);

    const after = await repo.allCards();
    const storedRecognition = after.find((row) => row.id === recognition.id)!;
    const storedProduction = after.find((row) => row.id === production.id)!;

    // The graded twin moved…
    expect(storedProduction.fsrs.reps).toBe(1);
    expect(storedProduction.due).toBeGreaterThan(NOW);
    expect(storedProduction.fsrs.state).not.toBe(0);
    // …and the other one did not, in any field the scheduler owns.
    expect(storedRecognition.due).toBe(recognition.due);
    expect(storedRecognition.fsrs).toEqual(recognition.fsrs);
    expect(storedRecognition.updatedAt).toBe(recognition.updatedAt);

    // And the reverse: grading the recognition card leaves the twin's new
    // schedule alone.
    await repo.grade(recognition.id, 1, NOW + DAY);
    const later = await repo.allCards();
    expect(later.find((row) => row.id === production.id)!.fsrs).toEqual(storedProduction.fsrs);

    // One review row per grade, each naming its own card.
    const reviews = await repo.allReviewsChronological();
    expect(reviews.map((row) => row.cardId)).toEqual([production.id, recognition.id]);
  });
});

/**
 * "Mark known" is a reading judgement, and it must stay one.
 *
 * `markKnown` reads `db.cards.where('entryId')` — the plain index, which spans
 * both directions — and bulk-writes `knownCardState` over every match, pushing
 * each card to Review with a year's stability. That retired a deliberately
 * created meaning → hanzi twin as a side effect of pressing "I can read this"
 * in the reader's token panel or a list row, and `unmarkKnown` does not undo
 * the re-dating, so there was no way back. PLAN §3.3 says nothing coordinates
 * the two schedules; this is the test that says so about this path.
 */
describe('marking a word known', () => {
  it('retires the recognition card and leaves the production twin alone', async () => {
    const repo = setup();
    const { recognition, production } = await pair(repo);
    await repo.grade(production.id, 3, NOW);
    const graded = (await repo.allCards()).find((row) => row.id === production.id)!;

    const rows = await repo.markKnown([recognition.entryId!]);
    expect(rows.map((row) => row.entryId)).toEqual([recognition.entryId]);

    const after = await repo.allCards();
    const storedRecognition = after.find((row) => row.id === recognition.id)!;
    const storedProduction = after.find((row) => row.id === production.id)!;

    // The reading card is retired: Review state, a year out.
    expect(storedRecognition.fsrs.state).toBe(2);
    expect(storedRecognition.fsrs.stability).toBeGreaterThanOrEqual(365);
    expect(storedRecognition.due).toBeGreaterThan(NOW + 300 * DAY);

    // The writing card keeps every field of the schedule it earned.
    expect(storedProduction.fsrs).toEqual(graded.fsrs);
    expect(storedProduction.due).toBe(graded.due);
    expect(storedProduction.updatedAt).toBe(graded.updatedAt);
  });

  it('still marks the word known when the only card is a production one', async () => {
    // The reader's "known" painting is about reading and is correct either way:
    // `known_words` gets its row whatever cards exist.
    const repo = setup();
    const { production } = await pair(repo);
    const before = await repo.allCards();
    const stored = before.find((row) => row.id === production.id)!;

    await repo.markKnown([production.entryId!]);
    expect(await repo.knownEntryIds()).toContain(production.entryId);
    const after = (await repo.allCards()).find((row) => row.id === production.id)!;
    expect(after.fsrs).toEqual(stored.fsrs);
  });
});

describe('the daily cap', () => {
  it('adds nothing to today just because the setting was turned on', async () => {
    const repo = setup();
    await repo.setSettings({ newPerDay: 10, productionDirection: true });
    const recognition = await repo.addCardFromEntry(DASUAN, context(), undefined, 'test');
    await repo.grade(recognition.id, 3, NOW - DAY);

    // Today, opened with the setting on and nothing else done.
    const summary = await loadToday({ repo, now: NOW, source: fakeEntrySource({}) });

    expect((await repo.allCards()).filter((card) => card.direction === 'production')).toEqual([]);
    expect(summary.queue.cards.every((card) => card.direction === 'recognition')).toBe(true);
  });

  it('creates at most the day remaining allowance, and spends it', async () => {
    const repo = setup();
    await repo.setSettings({ newPerDay: 1, dayRollover: 4 });

    for (const entry of [DASUAN, KANKAN]) {
      const card = await repo.addCardFromEntry(entry, context({ source: 'lookup' }), undefined, 'test');
      await repo.grade(card.id, 3, NOW - DAY);
    }

    const outcome = await addProductionTwins({ repo, now: NOW, charge: true, source: 'list' });
    expect(outcome.limit).toBe(1);
    expect(outcome.created).toHaveLength(1);
    expect(outcome.pending).toBe(1);
    expect(outcome.created[0].direction).toBe('production');
    // The card came from the recognition card's own snapshot, and kept its
    // sentence while being re-sourced to the list that paid for it.
    expect(outcome.created[0].context?.source).toBe('list');
    expect(outcome.created[0].context?.sentence).toBe(context().sentence);

    // The day was charged, so the spine gets one fewer word rather than the
    // learner getting a second allowance.
    const settings = await repo.getSettings();
    expect(settings.introduced[todayKey(NOW, settings.dayRollover)]).toBe(1);

    // A second pass on the same day has nothing left to spend.
    const again = await addProductionTwins({ repo, now: NOW, charge: true, source: 'list' });
    expect(again.created).toEqual([]);
    expect(again.pending).toBe(1);
  });

  it('only twins the entries it was asked about', async () => {
    const repo = setup();
    await repo.setSettings({ newPerDay: 10 });
    const first = await repo.addCardFromEntry(DASUAN, context(), undefined, 'test');
    const second = await repo.addCardFromEntry(KANKAN, context(), undefined, 'test');
    await repo.grade(first.id, 3, NOW - DAY);
    await repo.grade(second.id, 3, NOW - DAY);

    const outcome = await addProductionTwins({
      repo,
      now: NOW,
      entryIds: [second.entryId!],
      source: 'list',
    });
    expect(outcome.created).toHaveLength(1);
    expect(outcome.created[0].entryId).toBe(second.entryId);
  });
});
