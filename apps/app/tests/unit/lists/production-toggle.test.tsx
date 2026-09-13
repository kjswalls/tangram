/**
 * The per-list "also study production" toggle (Phase 8, builder B).
 *
 * What is pinned here is the promise the control makes on the page: turning it
 * on makes reverse cards for the words in *this* list that are already being
 * learned, no more than the day's remaining new-card allowance of them, and it
 * says how many are still waiting. Turning it off stops the next pass and
 * deletes nothing.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ProductionListToggle } from '@/components/lists/production-list-toggle';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import { PRODUCTION_LISTS_KEY } from '@/lib/srs/direction-prefs';
import { context, DASUAN, KANKAN } from '../db/fixtures';

afterEach(async () => {
  localStorage.removeItem(PRODUCTION_LISTS_KEY);
  await getDb().delete();
  await closeDb();
});

/**
 * Two words the learner has met once each, so both are eligible for a twin.
 * They are *explicit* adds (a lookup), which by §3.3 do not spend the daily
 * allowance — so the cap the toggle then works to is the whole of `newPerDay`
 * rather than whatever these two left of it.
 */
async function seedStarted() {
  const repo = getRepository();
  const ids: string[] = [];
  for (const entry of [DASUAN, KANKAN]) {
    const card = await repo.addCardFromEntry(
      entry,
      context({ source: 'lookup' }),
      undefined,
      'test',
    );
    await repo.grade(card.id, 3, Date.now() - 86_400_000 * 10);
    ids.push(card.entryId!);
  }
  return { repo, ids };
}

describe('also study production, for one list', () => {
  it('is not offered at all until the learner has asked for the direction', async () => {
    const repo = getRepository();
    await repo.setSettings({ productionDirection: false });
    const { container } = render(<ProductionListToggle listId="list-1" entryIds={[]} />);
    await waitFor(() => expect(container.querySelector('[data-testid="list-production"]')).toBeNull());
  });

  it('adds this list reverse cards under the daily cap, and says what is left', async () => {
    const { repo, ids } = await seedStarted();
    await repo.setSettings({ newPerDay: 1, productionDirection: true });

    render(<ProductionListToggle listId="list-1" entryIds={ids} />);
    const toggle = await screen.findByTestId('list-production-toggle');
    expect(toggle).not.toBeChecked();
    expect(screen.getByTestId('list-production-status')).toHaveTextContent('Off');

    fireEvent.click(toggle);

    await waitFor(async () =>
      expect(
        (await repo.allCards()).filter((card) => card.direction === 'production'),
      ).toHaveLength(1),
    );
    // One today, one waiting — the cap is the cap, and the line says so.
    const status = screen.getByTestId('list-production-status');
    await waitFor(() => expect(status).toHaveTextContent('1 reverse card added today'));
    expect(status).toHaveTextContent('1 more');

    // The day was charged for it, so the spine gets one word fewer rather than
    // the learner quietly getting a second allowance.
    const settings = await repo.getSettings();
    expect(Object.values(settings.introduced)).toEqual([1]);
  });

  it('remembers the choice, and turning it off keeps the cards already made', async () => {
    const { repo, ids } = await seedStarted();
    await repo.setSettings({ newPerDay: 10, productionDirection: true });

    const first = render(<ProductionListToggle listId="list-1" entryIds={ids} />);
    fireEvent.click(await screen.findByTestId('list-production-toggle'));
    await waitFor(async () =>
      expect(
        (await repo.allCards()).filter((card) => card.direction === 'production'),
      ).toHaveLength(2),
    );
    first.unmount();

    // Re-opened: the toggle is where it was left.
    const second = render(<ProductionListToggle listId="list-1" entryIds={ids} />);
    await waitFor(async () => expect(await screen.findByTestId('list-production-toggle')).toBeChecked());
    fireEvent.click(screen.getByTestId('list-production-toggle'));
    await waitFor(() => expect(screen.getByTestId('list-production-toggle')).not.toBeChecked());
    second.unmount();

    // Off means "make no more", not "take back the two you have".
    expect((await repo.allCards()).filter((card) => card.direction === 'production')).toHaveLength(
      2,
    );
    render(<ProductionListToggle listId="list-1" entryIds={ids} />);
    await waitFor(async () => expect(await screen.findByTestId('list-production-toggle')).not.toBeChecked());
  });
});
