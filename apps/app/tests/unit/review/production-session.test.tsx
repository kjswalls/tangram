/**
 * The production direction inside the real session (Phase 8, builder B).
 *
 * This is the feature end to end, minus the browser: a production card in the
 * queue is drawn by `ProductionCard`, its answer box is Phase 7's `RecallInput`
 * with a different grader behind it, and the three promises that grader makes
 * are checked against a live store and a live database:
 *
 *  1. an exact answer is judged **in the browser** — `fetch` is stubbed to
 *     throw, and the suggestion still arrives;
 *  2. the suggestion rings a button and nothing more — the review row records
 *     the grade the learner pressed, which is deliberately a different one;
 *  3. the twin's schedule is untouched by any of it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReviewSession } from '@/components/review/review-session';
import { resetExamplesInfo } from '@/components/review/example-sentences';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import { entryFromSnapshot, wordSnapshot } from '@/lib/srs/direction';
import { useReviewStore } from '@/lib/stores/review';
import { context, DASUAN } from '../db/fixtures';

afterEach(async () => {
  vi.unstubAllGlobals();
  resetExamplesInfo();
  useReviewStore.getState().reset();
  await getDb().delete();
  await closeDb();
});

/** A production card for 打算, plus the recognition card it was made from. */
async function seedPair() {
  const repo = getRepository();
  // `examplesOnBack` off: the i+1 block is another feature's network call and
  // this test is about a grader that makes none.
  await repo.setSettings({ newPerDay: 0, examplesOnBack: false, productionDirection: true });
  const recognition = await repo.addCardFromEntry(DASUAN, context(), undefined, 'test');
  await repo.grade(recognition.id, 3, Date.now() - 86_400_000 * 30);
  const stored = (await repo.allCards()).find((row) => row.id === recognition.id)!;
  const production = await repo.addCardFromEntry(
    entryFromSnapshot(stored.entryId!, wordSnapshot(stored.snapshot)!),
    context(),
    undefined,
    'test',
    'production',
  );
  return { repo, recognition: stored, production };
}

describe('a production card in the session', () => {
  it('asks for the hanzi, grades an exact answer with no network, and still lets the learner decide', async () => {
    const { repo, recognition, production } = await seedPair();
    // Any request at all is a failure of the local grader.
    const fetchMock = vi.fn(async () => {
      throw new Error('the production grader must not reach the network for an exact match');
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ReviewSession />);
    await screen.findByTestId('review-card');

    // The due recognition card comes first (it is due; the twin is New), so
    // walk to the production one — proving in passing that the two are
    // separate cards in one queue.
    const cards = () => screen.getByTestId('review-card');
    if (cards().getAttribute('data-direction') !== 'production') {
      fireEvent.keyDown(window, { key: ' ' });
      await screen.findByTestId('card-back');
      fireEvent.keyDown(window, { key: '3' });
      await waitFor(() =>
        expect(cards().getAttribute('data-direction')).toBe('production'),
      );
    }

    expect(cards().getAttribute('data-card-id')).toBe(production.id);
    const front = screen.getByTestId('card-front');
    expect(front).toHaveTextContent('to plan');
    expect(front.textContent).not.toContain('打算');

    // The box is the card's question, and it is offered without
    // `settings.freeRecall` — which is off here.
    const answer = screen.getByTestId('recall-answer');
    fireEvent.change(answer, { target: { value: '打算' } });
    fireEvent.keyDown(answer, { key: 'Enter' });

    // Flipped, and judged locally.
    await screen.findByTestId('card-back');
    const suggestion = await screen.findByTestId('recall-suggestion');
    expect(suggestion).toHaveAttribute('data-suggested', '3');
    expect(screen.getByTestId('grade-3')).toHaveAttribute('data-suggested', 'true');
    // Local means local: no request, and so no offline badge to explain one.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('recall-offline')).toBeNull();

    // A suggestion is advice. The learner presses 2.
    const before = await repo.allCards();
    fireEvent.keyDown(window, { key: '2' });
    await waitFor(async () =>
      expect((await getDb().reviews.where('cardId').equals(production.id).toArray()).length).toBe(1),
    );
    const [row] = await getDb().reviews.where('cardId').equals(production.id).toArray();
    expect(row.rating).toBe(2);

    // And the recognition twin's schedule is exactly where it was.
    const after = await repo.allCards();
    const wasRecognition = before.find((card) => card.id === recognition.id)!;
    const isRecognition = after.find((card) => card.id === recognition.id)!;
    expect(isRecognition.fsrs).toEqual(wasRecognition.fsrs);
    expect(isRecognition.due).toBe(wasRecognition.due);
  });

  it('offers "add the reverse" on a recognition back only when the setting is on', async () => {
    const repo = getRepository();
    await repo.setSettings({ newPerDay: 0, examplesOnBack: false, productionDirection: false });
    const card = await repo.addCardFromEntry(DASUAN, context(), undefined, 'test');

    const { unmount } = render(<ReviewSession />);
    await screen.findByTestId('review-card');
    fireEvent.keyDown(window, { key: ' ' });
    await screen.findByTestId('card-back');
    expect(screen.queryByTestId('add-reverse')).toBeNull();
    unmount();

    await repo.setSettings({ productionDirection: true });
    useReviewStore.getState().reset();
    render(<ReviewSession />);
    await screen.findByTestId('review-card');
    fireEvent.keyDown(window, { key: ' ' });
    await screen.findByTestId('card-back');

    const button = await screen.findByTestId('add-reverse-button');
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    await waitFor(async () =>
      expect(await repo.cardForEntry(card.entryId!, undefined, 'production')).toBeDefined(),
    );
    // One press, one card — and a second press cannot make a third.
    expect((await repo.allCards()).filter((row) => row.direction === 'production')).toHaveLength(1);
    expect(await screen.findByTestId('add-reverse')).toHaveAttribute('data-phase', 'present');
  });
});
