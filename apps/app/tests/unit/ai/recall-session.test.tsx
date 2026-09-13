/**
 * Free recall inside the real review session (PLAN.md §4, Phase 6 item 2).
 *
 * The unit under test is the whole path a learner walks: the setting, the box
 * on the front, the flip, the suggested button, and the grade they actually
 * press. The store, the repository and the card are all the real ones — only
 * `fetch` is a stub, because the suggestion has to be made to arrive *late* on
 * purpose. That is the case the feature's one rule is about: a suggestion that
 * lands while the card is sitting there graded by nobody must not grade it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReviewSession } from '@/components/review/review-session';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import { useReviewStore } from '@/lib/stores/review';
import { context, DASUAN } from '../db/fixtures';

afterEach(async () => {
  vi.unstubAllGlobals();
  useReviewStore.getState().reset();
  await getDb().delete();
  await closeDb();
});

/**
 * A `fetch` whose one call to `/api/recall` is settled by hand, whenever the
 * test says so. Everything else fails the way an offline browser fails — the
 * session's own spine draw is off (`newPerDay: 0`) and the card back's example
 * sentences are off (`examplesOnBack: false`, Phase 6 item 1, which shares this
 * component), so nothing else should be asking, and a call that did would be
 * visible rather than silently pending.
 */
function deferredFetch() {
  let settle: ((response: Response) => void) | undefined;
  const impl = vi.fn((...args: Parameters<typeof fetch>) => {
    if (!String(args[0]).includes('/api/recall')) {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    return new Promise<Response>((resolve) => {
      settle = resolve;
    });
  });
  vi.stubGlobal('fetch', impl);
  return {
    impl,
    answer(body: unknown, init: { ok?: boolean; status?: number } = {}) {
      settle?.({
        ok: init.ok ?? true,
        status: init.status ?? 200,
        json: async () => body,
      } as Response);
    },
  };
}

async function openSession(
  settings: { freeRecall?: boolean; examplesOnBack?: boolean } = { freeRecall: true },
) {
  const repo = getRepository();
  // The spine draw is another feature's; these cards are the ones seeded here.
  // So is the i+1 block on the back: it fetches at the flip, and this file
  // counts calls to prove that nothing but the recall box asked anyone.
  await repo.setSettings({ newPerDay: 0, examplesOnBack: false, ...settings });
  const card = await repo.addCardFromEntry(DASUAN, context({ source: 'lookup' }));
  render(<ReviewSession />);
  await screen.findByTestId('review-card');
  return card;
}

function type(answer: string) {
  const box = screen.getByTestId('recall-answer');
  fireEvent.change(box, { target: { value: answer } });
  fireEvent.keyDown(box, { key: 'Enter' });
}

describe('free recall in a review session', () => {
  it('is not offered unless the learner asked for it', async () => {
    await openSession({ freeRecall: false });
    expect(screen.queryByTestId('card-recall')).toBeNull();
    expect(screen.queryByTestId('recall-answer')).toBeNull();
  });

  it('flips at once, suggests late, and still grades only what the learner pressed', async () => {
    const fetcher = deferredFetch();
    await openSession();
    expect(screen.getByTestId('card-recall')).toBeVisible();

    type('to plan, to intend');

    // The flip did not wait for anyone: the back is up while the request is
    // still outstanding, and the four buttons are already live.
    expect(await screen.findByTestId('card-back')).toBeVisible();
    expect(screen.getByTestId('grade-bar')).toBeVisible();
    expect(screen.getByTestId('recall-thinking')).toBeVisible();
    expect(await getDb().reviews.count()).toBe(0);
    expect(fetcher.impl).toHaveBeenCalledOnce();

    // The suggestion arrives with the card still sitting there, ungraded.
    fetcher.answer({ suggested: 4, why: 'That covers the sense.' });
    const suggestion = await screen.findByTestId('recall-suggestion');
    expect(suggestion).toHaveAttribute('data-suggested', '4');
    expect(screen.getByTestId('recall-why')).toHaveTextContent('That covers the sense.');
    expect(screen.getByTestId('grade-4')).toHaveAttribute('data-suggested', 'true');
    expect(screen.getByTestId('grade-2')).not.toHaveAttribute('data-suggested');

    // The rule: arriving is not pressing. Nothing has been written.
    expect(await getDb().reviews.count()).toBe(0);

    // The learner disagrees, and the learner wins.
    fireEvent.keyDown(window, { key: '2' });
    await waitFor(async () => expect(await getDb().reviews.count()).toBe(1));
    const [row] = await getDb().reviews.toArray();
    expect(row.rating).toBe(2);
  });

  it('takes the keyboard, so a space in the answer is a space and not a flip', async () => {
    // Without focus the box is eight tabs or a mouse trip away, and — worse —
    // the first space in a natural answer ("close by") reaches the session's
    // window listener as a *reveal* key: the card flips mid-word and the box
    // disables itself. The session ignores keys aimed at an `INPUT`, so focus
    // is what makes a space a space.
    const fetcher = deferredFetch();
    await openSession();

    const box = screen.getByTestId('recall-answer');
    expect(box).toHaveFocus();

    fireEvent.keyDown(box, { key: ' ' });
    expect(screen.queryByTestId('card-back')).toBeNull();
    expect(box).not.toBeDisabled();
    expect(screen.queryByTestId('recall-missed')).toBeNull();
    expect(fetcher.impl).not.toHaveBeenCalled();

    // And the keys still grade once the answer is in and focus is handed back.
    type('to plan');
    await screen.findByTestId('card-back');
    fireEvent.keyDown(window, { key: '2' });
    await waitFor(async () => expect(await getDb().reviews.count()).toBe(1));
  });

  it('says who graded it when the grader is the offline one', async () => {
    // The two comparable surfaces both badge the fake (the ask panel, the i+1
    // block). A grade recommendation is the most consequential thing this app
    // suggests, so it does not get to be the one that does not say.
    const fetcher = deferredFetch();
    await openSession();

    type('to plan');
    fetcher.answer({ suggested: 3, why: 'Offline check: two of three words.', provider: 'fake' });
    await screen.findByTestId('recall-suggestion');
    expect(screen.getByTestId('recall-offline')).toBeVisible();
  });

  it('says nothing about being offline when a real model answered', async () => {
    const fetcher = deferredFetch();
    await openSession();

    type('to plan');
    fetcher.answer({ suggested: 3, why: 'The gist is there.', provider: 'anthropic' });
    await screen.findByTestId('recall-suggestion');
    expect(screen.queryByTestId('recall-offline')).toBeNull();
  });

  it('draws the suggestion on the Good button too, where the ring is invisible', async () => {
    // 3 renders as the primary button — `bg-accent` — and `ring-accent` on it
    // is the same colour on the same pixel. A suggestion of 3 is what a right
    // but differently-worded answer scores, so it is a common suggestion and
    // cannot be the one that shows nothing.
    const fetcher = deferredFetch();
    await openSession();

    type('to intend');
    fetcher.answer({ suggested: 3, why: 'The gist is there.' });
    await screen.findByTestId('recall-suggestion');

    const good = screen.getByTestId('grade-3');
    expect(good).toHaveAttribute('data-suggested', 'true');
    expect(good).toHaveTextContent('suggested');
    for (const other of ['grade-1', 'grade-2', 'grade-4']) {
      expect(screen.getByTestId(other)).not.toHaveTextContent('suggested');
    }
  });

  it('closes the box when the card is flipped another way, rather than grading the back', async () => {
    const fetcher = deferredFetch();
    await openSession();

    // Space flips it without an answer: the recall question has gone unanswered
    // and cannot now be asked, because the glosses are on screen.
    fireEvent.keyDown(window, { key: ' ' });
    await screen.findByTestId('card-back');
    expect(screen.getByTestId('recall-answer')).toBeDisabled();
    expect(screen.queryByTestId('recall-submit')).toBeNull();
    expect(screen.getByTestId('recall-missed')).toBeVisible();
    expect(fetcher.impl).not.toHaveBeenCalled();
  });

  it('asks nobody when the box is empty, and flips all the same', async () => {
    const fetcher = deferredFetch();
    await openSession();

    fireEvent.keyDown(screen.getByTestId('recall-answer'), { key: 'Enter' });

    expect(await screen.findByTestId('card-back')).toBeVisible();
    expect(fetcher.impl).not.toHaveBeenCalled();
    expect(screen.queryByTestId('recall-suggestion')).toBeNull();
    // Nothing was tried, so nothing failed: no line about it either.
    expect(screen.queryByTestId('recall-no-suggestion')).toBeNull();
  });

  it('leaves the card gradeable when the provider fails, and does not shout about it', async () => {
    const fetcher = deferredFetch();
    await openSession();

    type('to plan');
    expect(await screen.findByTestId('card-back')).toBeVisible();

    fetcher.answer({ error: 'provider-failed' }, { ok: false, status: 502 });
    expect(await screen.findByTestId('recall-no-suggestion')).toBeVisible();
    expect(screen.queryByTestId('recall-suggestion')).toBeNull();
    expect(screen.getByTestId('grade-3')).not.toHaveAttribute('data-suggested');

    fireEvent.keyDown(window, { key: '3' });
    await waitFor(async () => expect(await getDb().reviews.count()).toBe(1));
    expect((await getDb().reviews.toArray())[0].rating).toBe(3);
  });

  it('keeps the typed answer on screen beside the suggestion', async () => {
    const fetcher = deferredFetch();
    await openSession();

    type('to intend');
    fetcher.answer({ suggested: 3, why: 'The gist is there.' });
    await screen.findByTestId('recall-suggestion');

    const box = screen.getByTestId('recall-answer') as HTMLInputElement;
    expect(box.value).toBe('to intend');
    // And it cannot be answered twice: the question has been asked.
    expect(box).toBeDisabled();
    expect(screen.queryByTestId('recall-submit')).toBeNull();
    expect(fetcher.impl).toHaveBeenCalledOnce();
  });

  it('carries the sense the card is about to the route', async () => {
    const fetcher = deferredFetch();
    const repo = getRepository();
    await repo.setSettings({ newPerDay: 0, freeRecall: true, examplesOnBack: false });
    await repo.addCardFromEntry(DASUAN, context({ source: 'lookup' }), 1);
    render(<ReviewSession />);
    await screen.findByTestId('review-card');

    type('to intend');
    const options = fetcher.impl.mock.calls[0][1];
    expect(JSON.parse(String(options?.body))).toEqual({
      entryId: DASUAN.id,
      senseIndex: 1,
      answer: 'to intend',
    });
  });
});
