import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReviewSession } from '@/components/review/review-session';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import { gradeOptions } from '@/lib/srs/session';
import { useReviewStore } from '@/lib/stores/review';
import { resetExamplesInfo } from '@/components/review/example-sentences';
import type { Entry } from '@/lib/types';
import { context, DASUAN, KANKAN } from '../db/fixtures';

const DAY = 86_400_000;

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
    expect(stored?.due).toBeGreaterThanOrEqual(rows[0].reviewedAt + DAY);
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
      expect(option.interval).toMatch(/^\d+(\.\d)?(d|mo|y)$/);
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
    await repo.grade(card.id, 3, Date.now());

    render(<ReviewSession />);
    const empty = await screen.findByTestId('review-empty');
    expect(empty).toHaveTextContent(/Nothing due — next card in \d+ (hours?|days?)\./);
    expect(screen.queryByTestId('review-card')).toBeNull();
  });

  it('says so when there is nothing scheduled at all', async () => {
    render(<ReviewSession />);
    const empty = await screen.findByTestId('review-empty');
    expect(empty).toHaveTextContent('Nothing due — no cards are scheduled yet.');
  });
});
