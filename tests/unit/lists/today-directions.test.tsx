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
    await repo.setSettings({ newPerDay: 0, productionDirection: true });
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

    // A word and its reverse are two rows, and they must not be the same row
    // twice: the reverse leads with what it asks for and carries its own badge.
    const rows = screen.getAllByTestId('today-new-word');
    expect(rows).toHaveLength(3);
    const reverse = rows.filter((row) => row.dataset.direction === 'production');
    expect(reverse).toHaveLength(1);
    expect(reverse[0]).toHaveTextContent(/write/);
    expect(reverse[0]).toHaveTextContent(/reverse/);
    const recognition = rows.filter((row) => row.dataset.direction === 'recognition');
    expect(recognition).toHaveLength(2);
    for (const row of recognition) expect(row).not.toHaveTextContent(/write/);
  });

  /**
   * "Also practise the other direction", turned off, used to change nothing a
   * learner could see: the twins they had already made kept being served, Today
   * kept counting them, and with no way to delete a card there was no way out.
   * The label promises a study switch, so it is one — and the row survives, so
   * turning it back on restores the schedule the card earned.
   */
  it('stops offering production cards when the setting is off, without deleting them', async () => {
    const repo = getRepository();
    await repo.setSettings({ newPerDay: 0, productionDirection: true });
    const first = await repo.addCardFromEntry(
      DASUAN,
      context({ source: 'lookup' }),
      undefined,
      'test',
    );
    const twin = await repo.addCardFromEntry(
      entryFromSnapshot(first.entryId!, wordSnapshot(first.snapshot)!),
      context({ source: 'lookup' }),
      undefined,
      'test',
      'production',
    );

    await repo.setSettings({ productionDirection: false });
    render(<TodayView />);
    await waitFor(() => expect(screen.getByTestId('today-new-count')).toHaveTextContent('1'));
    expect(screen.queryByTestId('today-direction-split')).toBeNull();
    expect(
      screen.getAllByTestId('today-new-word').filter((row) => row.dataset.direction === 'production'),
    ).toHaveLength(0);

    // The card itself is untouched — hidden, not deleted.
    const stored = await repo.cardForEntry(first.entryId!, undefined, 'production');
    expect(stored?.id).toBe(twin.id);
    expect(stored?.deletedAt).toBeNull();
  });
});
