/**
 * Today, counting the two directions apart (Phase 8, builder B).
 *
 * "12 cards" stops meaning one thing the moment a word can carry two, so the
 * page says which half is which — and says nothing at all until there is a
 * production card to say it about, because a split with a zero on one side is
 * just noise on the page of a learner who never turned it on.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TodayView } from '@/app/(today)/today-view';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import { entryFromSnapshot, wordSnapshot } from '@/lib/srs/direction';
import { context, DASUAN, KANKAN } from '../db/fixtures';

afterEach(async () => {
  await getDb().delete();
  await closeDb();
});

describe('the Today counts', () => {
  it('says nothing about direction while every card is a recognition card', async () => {
    const repo = getRepository();
    await repo.setSettings({ newPerDay: 0 });
    await repo.addCardFromEntry(DASUAN, context({ source: 'lookup' }), undefined, 'test');

    render(<TodayView />);
    // The counts render as em dashes until the summary lands, so wait for the
    // number rather than for the element.
    await waitFor(() => expect(screen.getByTestId('today-new-count')).toHaveTextContent('1'));
    expect(screen.queryByTestId('today-direction-split')).toBeNull();
  });

  it('counts the directions separately once a word is being produced too', async () => {
    const repo = getRepository();
    await repo.setSettings({ newPerDay: 0 });
    const first = await repo.addCardFromEntry(
      DASUAN,
      context({ source: 'lookup' }),
      undefined,
      'test',
    );
    await repo.addCardFromEntry(KANKAN, context({ source: 'lookup' }), undefined, 'test');
    await repo.addCardFromEntry(
      entryFromSnapshot(first.entryId!, wordSnapshot(first.snapshot)!),
      context({ source: 'lookup' }),
      undefined,
      'test',
      'production',
    );

    render(<TodayView />);
    const split = await screen.findByTestId('today-direction-split');
    expect(split).toBeVisible();
    expect(screen.getByTestId('today-recognition-count')).toHaveTextContent('2');
    expect(screen.getByTestId('today-production-count')).toHaveTextContent('1');
    // Three cards on offer, and the page still says three.
    expect(screen.getByTestId('today-new-count')).toHaveTextContent('3');
  });
});
