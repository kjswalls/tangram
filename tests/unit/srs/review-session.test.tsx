import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReviewSession } from '@/components/review/review-session';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import { gradeOptions, MAX_SESSION_REPEATS } from '@/lib/srs/session';
import { useReviewStore } from '@/lib/stores/review';
import { resetExamplesInfo } from '@/components/review/example-sentences';
import type { Entry } from '@/lib/types';
import { context, DASUAN, KANKAN } from '../db/fixtures';


afterEach(async () => {
  vi.unstubAllGlobals();
  resetExamplesInfo();
  useReviewStore.getState().reset();
  await getDb().delete();
  await closeDb();
});

/** The session component drives the real store against a real (fake-indexed) db. */
describe('the review session', () => {
  it('flips on space and grades on 1–4, ignoring every other key', async () => {
    const repo = getRepository();
    const card = await repo.addCardFromEntry(DASUAN, context({ source: 'lookup' }));

    render(<ReviewSession />);
    await screen.findByTestId('review-card');
    expect(screen.getByTestId('card-front')).toHaveTextContent('打算');
    expect(screen.queryByTestId('card-back')).toBeNull();

    // A grade key before the flip is not a grade: you cannot rate what you have
    // not seen. Nor is any other key a flip.
    fireEvent.keyDown(window, { key: '3' });
    fireEvent.keyDown(window, { key: 'x' });
    expect(screen.queryByTestId('card-back')).toBeNull();
    expect(await getDb().reviews.count()).toBe(0);

    fireEvent.keyDown(window, { key: ' ' });
    const back = await screen.findByTestId('card-back');
    expect(back).toHaveTextContent('dǎsuàn');
    expect(back).toHaveTextContent('to plan');
    expect(screen.getByTestId('grade-bar')).toBeVisible();

    // Still ignoring the keys that mean nothing here.
    fireEvent.keyDown(window, { key: '0' });
    fireEvent.keyDown(window, { key: '5' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(await getDb().reviews.count()).toBe(0);

    fireEvent.keyDown(window, { key: '3' });
    await waitFor(async () => expect(await getDb().reviews.count()).toBe(1));

    const rows = await getDb().reviews.toArray();
    expect(rows[0].cardId).toBe(card.id);
    expect(rows[0].rating).toBe(3);
    const stored = await getDb().cards.get(card.id);
    // The grade rescheduled the card. How far out is the scheduler's business
    // and the settings row's: with `shortTermSteps` on (the default since
    // Phase 8) Good on a new card is a learning step, not a day.
    expect(stored?.due).toBeGreaterThan(rows[0].reviewedAt);
    expect(stored?.fsrs.reps).toBe(1);
  });

  it('re-queries after a grade: the next card is shown and the graded one is not', async () => {
    const repo = getRepository();
    await repo.addCardFromEntry(DASUAN, context({ source: 'lookup' }));
    await repo.addCardFromEntry(KANKAN, context({ source: 'reader' }));

    render(<ReviewSession />);
    const first = await screen.findByTestId('review-card');
    const firstId = first.getAttribute('data-card-id');
    expect(screen.getByTestId('review-progress')).toHaveTextContent('Card 1 of 2');

    fireEvent.keyDown(window, { key: ' ' });
    await screen.findByTestId('card-back');
    fireEvent.keyDown(window, { key: '3' });

    await waitFor(() => {
      expect(screen.getByTestId('review-card').getAttribute('data-card-id')).not.toBe(firstId);
    });
    expect(screen.getByTestId('review-progress')).toHaveTextContent('Card 2 of 2');
    // The card that was graded is out of the session, and the fresh one is face down.
    expect(screen.queryByTestId('card-back')).toBeNull();
  });

  it('labels the four buttons with the interval each would schedule', async () => {
    const repo = getRepository();
    const card = await repo.addCardFromEntry(DASUAN, context({ source: 'lookup' }));

    render(<ReviewSession />);
    await screen.findByTestId('review-card');
    fireEvent.keyDown(window, { key: 'Enter' });
    await screen.findByTestId('card-back');

    const expected = gradeOptions(card.fsrs, useReviewStore.getState().now);
    for (const option of expected) {
      const button = screen.getByTestId(`grade-${option.rating}`);
      expect(button).toHaveTextContent(option.label);
      expect(button).toHaveAttribute('data-interval', option.interval);
      // `10m` and `2h` are labels now (Phase 8's learning steps), so the shape
      // is a number and one of the five units — not days-or-longer only.
      expect(option.interval).toMatch(/^\d+(\.\d)?(m|h|d|mo|y)$/);
    }
  });

  it('peeks the sentence with the target masked, and marks it on the back', async () => {
    const repo = getRepository();
    // The reader recorded where 打算 sits in 我打算明天去北京。
    await repo.addCardFromEntry(DASUAN, context());

    render(<ReviewSession />);
    await screen.findByTestId('review-card');

    fireEvent.click(screen.getByTestId('peek-context'));
    const peek = await screen.findByTestId('context-peek');
    expect(peek).toHaveTextContent('我＿＿明天去北京。');
    expect(peek).not.toHaveTextContent('打算');

    fireEvent.keyDown(window, { key: ' ' });
    const line = await screen.findByTestId('context-back');
    expect(line).toHaveTextContent('我打算明天去北京。');
    expect(screen.getByTestId('context-target')).toHaveTextContent('打算');
  });

  it('shows the chosen sense first and folds the others away', async () => {
    const repo = getRepository();
    await repo.addCardFromEntry(DASUAN, context({ source: 'ask' }), 1);

    render(<ReviewSession />);
    await screen.findByTestId('review-card');
    fireEvent.keyDown(window, { key: ' ' });

    const glosses = await screen.findByTestId('card-glosses');
    expect(glosses).toHaveTextContent('to intend');
    expect(glosses).not.toHaveTextContent('to plan');
    const others = screen.getByTestId('other-senses');
    expect(others).toHaveTextContent('Other senses (2)');
    expect(others).toHaveTextContent('to plan');
  });

  it('writes the i+1 sentences in the script the card front is written in', async () => {
    // The front honours `settings.script` through `cardFace`; the block under
    // the glosses is on the same card and answers the same preference. A
    // traditional-script learner reading simplified sentences under a
    // traditional headword is the app answering half a question.
    const XUEXI: Entry = {
      id: '學習|学习[xue2 xi2]',
      simp: '学习',
      trad: '學習',
      pinyinNum: 'xue2 xi2',
      pinyinMarked: 'xuéxí',
      glosses: ['to learn'],
      classifiers: [],
      properNoun: false,
      isVariant: false,
      surname: false,
      hskBand: 1,
      freqRank: 400,
    };
    resetExamplesInfo();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body =
          url === '/api/examples' && init?.method === 'POST'
            ? {
                provider: 'fake',
                promptVersion: 'v1',
                entryId: DASUAN.id,
                dictVersion: 'test',
                sentences: [
                  {
                    tokens: [{ entryId: XUEXI.id }, { entryId: DASUAN.id }],
                    en: 'I plan to study.',
                    register: '',
                    unverified: false,
                  },
                ],
                entries: [XUEXI, DASUAN],
                support: 1,
                cacheable: true,
              }
            : { provider: 'fake', promptVersion: 'v1' };
        return { ok: true, status: 200, json: async () => body } as Response;
      }),
    );

    const repo = getRepository();
    await repo.setSettings({ script: 'trad', newPerDay: 0 });
    await repo.addCardFromEntry(DASUAN, context({ source: 'lookup' }));

    render(<ReviewSession />);
    await screen.findByTestId('review-card');
    fireEvent.keyDown(window, { key: ' ' });
    await screen.findByTestId('card-back');

    const tokens = await screen.findAllByTestId('example-token');
    expect(tokens[0]).toHaveTextContent('學習');
    expect(tokens[0]).not.toHaveTextContent('学习');
    expect(tokens[0]).toHaveTextContent('xuéxí');
  });

  it('says when the next card is due once the queue is empty', async () => {
    const repo = getRepository();
    const card = await repo.addCardFromEntry(DASUAN, context({ source: 'lookup' }));
    // Off, so the card is a day out: with the short steps on it is ten minutes
    // away, which is the *other* empty state (below).
    await repo.setSettings({ shortTermSteps: false });
    await repo.grade(card.id, 3, Date.now());

    render(<ReviewSession />);
    const empty = await screen.findByTestId('review-empty');
    expect(empty).toHaveTextContent(/Nothing due — next card in \d+ (hours?|days?)\./);
    expect(screen.queryByTestId('review-card')).toBeNull();
  });

  it('says the card is coming back in minutes rather than declaring the session over', async () => {
    // The Phase 8 case: `shortTermSteps` defaults on, so Good on a new card is
    // a ten-minute learning step. Until this the empty state floored at an hour
    // and the learner was told to come back tomorrow-ish for a card that was
    // ten minutes away.
    const repo = getRepository();
    const card = await repo.addCardFromEntry(DASUAN, context({ source: 'lookup' }));
    await repo.grade(card.id, 3, Date.now());

    render(<ReviewSession />);
    const empty = await screen.findByTestId('review-empty');
    expect(empty).toHaveTextContent(/^Nothing due — 1 card comes back in \d+ minutes?\.$/);
  });

  it('sets aside a card the learner keeps failing, and says it did', async () => {
    // Again on a card in a learning step schedules it a minute out, so the
    // session would otherwise serve the same card for as long as 1 is pressed.
    // Each pass here grades, then re-reads five minutes later — which is what
    // the session's own refresh timer does when the queue empties.
    const repo = getRepository();
    const card = await repo.addCardFromEntry(DASUAN, context({ source: 'lookup' }));
    const base = Date.now();
    const store = useReviewStore.getState();

    render(<ReviewSession />);
    await screen.findByTestId('review-card');

    for (let i = 0; i < MAX_SESSION_REPEATS; i += 1) {
      await store.grade(1, base + i * 5 * 60_000);
      await store.load(base + (i + 1) * 5 * 60_000);
    }

    // The card is due at this instant — it is out of the session because the
    // session set it aside, not because the clock has not caught up.
    const empty = await screen.findByTestId('review-empty');
    expect(empty).toHaveTextContent('1 card you kept missing is set aside until next time.');
    expect(screen.queryByTestId('review-card')).toBeNull();
    // Six grades, six review rows: the cap ends the session, it does not
    // silently drop the last answer, and the card is not deleted.
    expect(await getDb().reviews.count()).toBe(MAX_SESSION_REPEATS);
    expect((await getDb().cards.get(card.id))?.deletedAt).toBeNull();

    // Leaving and coming back is the learner deciding to try again.
    store.reset();
    await store.load(base + 60 * 60_000);
    expect(useReviewStore.getState().queue).toHaveLength(1);
  });

  it('warns before the cap bites', async () => {
    const repo = getRepository();
    await repo.addCardFromEntry(DASUAN, context({ source: 'lookup' }));
    const base = Date.now();
    const store = useReviewStore.getState();

    render(<ReviewSession />);
    await screen.findByTestId('review-card');
    expect(screen.queryByTestId('review-repeat-notice')).toBeNull();

    for (let i = 0; i < MAX_SESSION_REPEATS - 2; i += 1) {
      await store.grade(1, base + i * 5 * 60_000);
      await store.load(base + (i + 1) * 5 * 60_000);
    }
    await screen.findByTestId('review-card');
    expect(await screen.findByTestId('review-repeat-notice')).toHaveTextContent(
      `Seen ${MAX_SESSION_REPEATS - 2} times this session`,
    );
  });

  it('comes back for a card that matures while the empty state is on screen', async () => {
    // Nothing brought a matured learning card back before Phase 8: the empty
    // state stood there until the learner reloaded the page. The card below is
    // a second away rather than ten minutes so the test can watch it happen.
    const repo = getRepository();
    const card = await repo.addCardFromEntry(DASUAN, context({ source: 'lookup' }));
    const at = Date.now();
    await repo.grade(card.id, 1, at);
    const due = Date.now() + 1_200;
    await getDb().cards.update(card.id, { due, 'fsrs.due': due });

    render(<ReviewSession />);
    await screen.findByTestId('review-empty');
    expect(screen.queryByTestId('review-card')).toBeNull();

    await waitFor(() => expect(screen.getByTestId('review-card')).toBeVisible(), {
      timeout: 8_000,
    });
  }, 15_000);

  it('says so when there is nothing scheduled at all', async () => {
    render(<ReviewSession />);
    const empty = await screen.findByTestId('review-empty');
    expect(empty).toHaveTextContent('Nothing due — no cards are scheduled yet.');
  });
});
