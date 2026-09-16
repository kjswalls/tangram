/**
 * Today, counting the two directions apart (Phase 8, builder B; reworded by
 * docs/plans/core.md C8).
 *
 * "12 cards" stops meaning one thing the moment a word can carry two, so the
 * page says which half is which — and says nothing at all until there is a
 * production card to say it about, because a clause with a zero in it is just
 * noise on the page of a learner who never turned it on.
 *
 * C8 replaced the tiles with one sentence and this file followed it there. The
 * rule under test is the same one: the writing half is counted and named
 * separately, and it disappears entirely when there is none.
 */
import { render, screen, waitFor } from '../render';
import { afterEach, describe, expect, it } from 'vitest';

import { TodayView } from '@/components/screens/today';
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
    // The sentence says it is counting until the summary lands, so wait for the
    // number rather than for the element.
    await waitFor(() =>
      expect(screen.getByTestId('today-sentence')).toHaveTextContent('1 new word to learn'),
    );
    expect(screen.getByTestId('today-sentence')).not.toHaveTextContent('write from memory');
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
    // Two to learn and one to write — three cards on offer, named apart. The
    // writing clause is what Phase 8 added and what C8 kept.
    const sentence = await screen.findByTestId('today-sentence');
    await waitFor(() => expect(sentence).toHaveTextContent('2 new words to learn'));
    expect(sentence).toHaveTextContent('1 to write from memory');

    // A word and its reverse are two rows, and they must not be the same row
    // twice: the reverse leads with what it asks for and carries its own badge.
    const rows = screen.getAllByTestId('today-new-word');
    expect(rows).toHaveLength(3);
    const reverse = rows.filter((row) => row.dataset.direction === 'production');
    expect(reverse).toHaveLength(1);
    // C8 names the direction "Write" rather than "reverse": the old word
    // described the operation that made the card, not what it asks of you.
    expect(reverse[0]).toHaveTextContent(/Write/);
    expect(reverse[0]).not.toHaveTextContent(/reverse/i);
    const recognition = rows.filter((row) => row.dataset.direction === 'recognition');
    expect(recognition).toHaveLength(2);
    for (const row of recognition) expect(row).not.toHaveTextContent(/Write/);
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
    await waitFor(() =>
      expect(screen.getByTestId('today-sentence')).toHaveTextContent('1 new word to learn'),
    );
    expect(screen.getByTestId('today-sentence')).not.toHaveTextContent('write from memory');
    expect(
      screen.getAllByTestId('today-new-word').filter((row) => row.dataset.direction === 'production'),
    ).toHaveLength(0);

    // The card itself is untouched — hidden, not deleted.
    const stored = await repo.cardForEntry(first.entryId!, undefined, 'production');
    expect(stored?.id).toBe(twin.id);
    expect(stored?.deletedAt).toBeNull();
  });
});
