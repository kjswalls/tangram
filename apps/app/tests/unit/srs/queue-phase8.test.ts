/**
 * The two Phase 8 queue rules, together (the merge of branches `a` and `b`).
 *
 * `lib/lists/queue.ts` was the one file both builders needed. Builder A gave
 * `queue.due` a priority: a card mid-step (FSRS Learning or Relearning) is
 * offered before the overdue Review pile, because its step is a measured few
 * minutes and a card three days overdue has already waited three days. Builder
 * B added no rule to the queue at all — a production card is an ordinary card —
 * but the *store* then reorders what the queue returns so that a word's two
 * directions are never shown back to back, and it filters out the cards this
 * session has set aside.
 *
 * Merged, those are three operations over one list, and the order they compose
 * in is load-bearing. This file pins:
 *
 *  1. both rules hold at once in the real store, over a real database — a
 *     learning card and a production card in one session, each scheduled by
 *     FSRS on its own;
 *  2. the filter runs **before** the spacing, because spacing a list and then
 *     removing rows from it can put a word's two directions back together.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { CardRow } from '@/lib/db/schema';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import { buildQueue } from '@/lib/lists/queue';
import { entryFromSnapshot, spaceDirections, wordSnapshot } from '@/lib/srs/direction';
import { sessionQueue } from '@/lib/srs/session';
import { useReviewStore } from '@/lib/stores/review';
import { context, DASUAN, KANKAN } from '../db/fixtures';

const NOW = new Date(2026, 8, 7, 12).getTime();
const MINUTE = 60_000;
const DAY = 86_400_000;

afterEach(async () => {
  useReviewStore.getState().reset();
  await getDb().delete();
  await closeDb();
});

/**
 * Three cards, all due at `NOW`, chosen so that the two orderings disagree:
 *
 * - 打算 recognition — failed a moment ago, so it is **mid-step** and the least
 *   overdue of the three. A's rule puts it first anyway.
 * - 打算 production — the most overdue Review card, so a sort by `due` alone
 *   would put it immediately behind its own recognition twin. B's rule must
 *   push something between them.
 * - 看看 recognition — an ordinary overdue Review card, and the only card that
 *   can go between the twins.
 */
async function seed() {
  const repo = getRepository();
  // No spine draw: this test is about the order of what already exists.
  await repo.setSettings({ newPerDay: 0, examplesOnBack: false, productionDirection: true });

  const kankan = await repo.addCardFromEntry(KANKAN, context(), undefined, 'test');
  await repo.grade(kankan.id, 4, NOW - 20 * DAY);

  const dasuan = await repo.addCardFromEntry(DASUAN, context(), undefined, 'test');
  await repo.grade(dasuan.id, 4, NOW - 30 * DAY);
  const graduated = (await repo.allCards()).find((row) => row.id === dasuan.id)!;

  const twin = await repo.addCardFromEntry(
    entryFromSnapshot(graduated.entryId!, wordSnapshot(graduated.snapshot)!),
    context(),
    undefined,
    'test',
    'production',
  );
  // The twin has its own history and is the most overdue card in the set.
  await repo.grade(twin.id, 4, NOW - 60 * DAY);

  // …and the recognition card fails, eleven minutes ago, so its ten-minute
  // relearning step has just matured: it is mid-step and due, by a minute.
  await repo.grade(dasuan.id, 1, NOW - 11 * MINUTE);

  const cards = await repo.allCards();
  const byId = (id: string) => cards.find((row) => row.id === id)!;
  return {
    repo,
    recognition: byId(dasuan.id),
    production: byId(twin.id),
    other: byId(kankan.id),
    cards,
  };
}

describe('a learning card and a production card in the same session', () => {
  it('are both due, and each is scheduled on its own', async () => {
    const { repo, recognition, production, other } = await seed();

    // The premises the ordering assertions rest on, stated rather than assumed.
    expect(recognition.direction).toBe('recognition');
    expect(production.direction).toBe('production');
    // Failing a graduated card puts it in Relearning (3) — a state that did not
    // occur at all before `shortTermSteps` defaulted on.
    expect(recognition.fsrs.state).toBe(3);
    expect(recognition.fsrs.lapses).toBe(1);
    expect(production.fsrs.state).toBe(2);
    expect(other.fsrs.state).toBe(2);
    // The mid-step card is the *least* overdue of the three…
    expect(recognition.due).toBeGreaterThan(production.due);
    expect(recognition.due).toBeGreaterThan(other.due);
    // …and its step is minutes, not days: it came back inside the session.
    expect(recognition.due - (NOW - 11 * MINUTE)).toBeLessThan(DAY);
    // …while the production twin was scheduled in days, by its own history.
    expect(production.due - (NOW - 60 * DAY)).toBeGreaterThan(DAY);

    // All three are on offer at NOW.
    const queue = buildQueue({ now: NOW, cards: await repo.allCards() });
    expect(queue.due.map((card) => card.id).sort()).toEqual(
      [recognition.id, production.id, other.id].sort(),
    );

    // Builder A's rule: mid-step first, whatever `due` says.
    expect(queue.due[0]!.id).toBe(recognition.id);
    // …and the rest by due instant behind it.
    expect(queue.due.slice(1).map((card) => card.id)).toEqual([production.id, other.id]);
  });

  it('are ordered by both rules at once in the session the learner sees', async () => {
    const { recognition, production, other } = await seed();

    await useReviewStore.getState().load(NOW);
    const queue = useReviewStore.getState().queue;

    expect(queue).toHaveLength(3);
    // A: the card mid-step is the one on screen first.
    expect(queue[0]!.id).toBe(recognition.id);
    // B: its own production twin is not the next thing asked — the answer to
    // the second question is on the back of the card just graded.
    expect(queue[1]!.id).toBe(other.id);
    expect(queue[2]!.id).toBe(production.id);
  });

  it('grades each direction on its own schedule from inside that session', async () => {
    const { repo, recognition, production } = await seed();

    await useReviewStore.getState().load(NOW);
    // The mid-step card is first; grade it Good and it takes another step.
    await useReviewStore.getState().grade(3, NOW);

    let stored = await repo.allCards();
    const afterStep = stored.find((row) => row.id === recognition.id)!;
    expect(afterStep.fsrs.reps).toBe(recognition.fsrs.reps + 1);
    // The production twin has not moved a field.
    expect(stored.find((row) => row.id === production.id)!.fsrs).toEqual(production.fsrs);

    // Walk to the production card and grade it; the relearning card stays put.
    const store = useReviewStore.getState();
    const index = store.queue.findIndex((card: CardRow) => card.id === production.id);
    expect(index).toBeGreaterThanOrEqual(0);
    await repo.grade(production.id, 4, NOW + MINUTE);

    stored = await repo.allCards();
    const gradedTwin = stored.find((row) => row.id === production.id)!;
    expect(gradedTwin.fsrs.reps).toBe(production.fsrs.reps + 1);
    expect(gradedTwin.due).toBeGreaterThan(NOW + DAY);
    expect(stored.find((row) => row.id === recognition.id)!.fsrs).toEqual(afterStep.fsrs);

    // One review row per grade, each naming its own card and nothing else.
    const reviews = await repo.allReviewsChronological();
    const graded = reviews.filter((row) => row.reviewedAt >= NOW).map((row) => row.cardId);
    expect(graded).toEqual([recognition.id, production.id]);
  });
});

describe('the order the two rules compose in', () => {
  /** Three cards: a word's two directions with one other card between them. */
  const card = (id: string, entryId: string, direction: 'recognition' | 'production'): CardRow =>
    ({ id, entryId, direction }) as unknown as CardRow;

  const twinA = card('a-recognition', 'entry-a', 'recognition');
  const middle = card('b-recognition', 'entry-b', 'recognition');
  const twinB = card('a-production', 'entry-a', 'production');

  it('filters the set-aside cards first, then spaces the directions', () => {
    const deferred = new Set([middle.id]);
    const cards = [twinA, middle, twinB];

    // The store's order: what is left after the filter is what gets spaced, and
    // with nothing left to put between them there is nothing to be done — but
    // the list is honest about what the session is actually offering.
    expect(spaceDirections(sessionQueue(cards, deferred)).map((c) => c.id)).toEqual([
      twinA.id,
      twinB.id,
    ]);

    // With a fourth card the filter leaves something to space with, and the
    // twins come apart.
    const spare = card('c-recognition', 'entry-c', 'recognition');
    expect(spaceDirections(sessionQueue([twinA, middle, twinB, spare], deferred)).map((c) => c.id)) //
      .toEqual([twinA.id, spare.id, twinB.id]);
  });

  it('would put the twins back together if it spaced first and filtered after', () => {
    // The bug this order avoids: `middle` is what separates the twins, so
    // removing it *after* the spacing undoes the spacing silently.
    const deferred = new Set([middle.id]);
    const spare = card('c-recognition', 'entry-c', 'recognition');
    const cards = [twinA, twinB, middle, spare];

    const wrong = sessionQueue(spaceDirections(cards), deferred).map((c) => c.id);
    expect(wrong).toEqual([twinA.id, twinB.id, spare.id]);
    // Adjacent twins — exactly what `spaceDirections` exists to prevent.
    expect(wrong.slice(0, 2)).toEqual([twinA.id, twinB.id]);

    const right = spaceDirections(sessionQueue(cards, deferred)).map((c) => c.id);
    expect(right).toEqual([twinA.id, spare.id, twinB.id]);
  });
});
