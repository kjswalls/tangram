/**
 * "Add the reverse" is an explicit add, and this is what that costs: nothing.
 *
 * The component's own header says it — "Unlike the per-list toggle this does not
 * spend the day's new-card allowance" — and so does PLAN §3.3 ("one card,
 * explicit, uncapped like every explicit add"). It was not true. The twin was
 * created with `twinContext(card, now)` and no source, which **inherits the
 * parent's**; every spine-drawn card carries `{source:'list'}`, so the twin was
 * non-explicit, `createdToday` counted it, and `drawLimit` fell by one. Pressing
 * it on ten cards in a session silently took the day's ten new spine words, with
 * nothing on screen saying so, and the ungraded twin took another slot the next
 * day as backlog.
 *
 * The fix is a provenance of its own (`source: 'reverse'`), so the test drives
 * the real component against a real database and then asks the real
 * `buildQueue` what the day has left.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AddReverse } from '@/components/review/add-reverse';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import type { CardRow } from '@/lib/db/schema';
import { buildQueue, isExplicitAdd } from '@/lib/lists/queue';
import { context, DASUAN } from '../db/fixtures';

const DAY = 86_400_000;

afterEach(async () => {
  await getDb().delete();
  await closeDb();
});

/** The same card with a different provenance — the one thing under test. */
function withSource(card: CardRow, source: 'list' | 'reverse'): CardRow {
  return { ...card, context: { ...card.context!, source } };
}

describe('adding the reverse of a card', () => {
  it('does not spend the day’s new-card allowance', async () => {
    const repo = getRepository();
    const settings = await repo.setSettings({ newPerDay: 10, productionDirection: true });
    // A spine-drawn recognition card: `{source:'list'}`, the default source of
    // cards in this app, and the one whose inheritance caused the charge.
    const spine = await repo.addCardFromEntry(
      DASUAN,
      context({ source: 'list' }),
      undefined,
      'test',
    );
    const now = Date.now();

    const before = buildQueue({ now, cards: await repo.allCards(), settings });
    expect(before.chargedToday).toBe(1);
    expect(before.drawLimit).toBe(9);

    render(<AddReverse card={spine} repo={repo} />);
    const button = await screen.findByTestId('add-reverse-button');
    await waitFor(() => expect(button).toBeEnabled());
    await act(async () => {
      fireEvent.click(button);
    });
    await screen.findByText(/Reverse card added/);

    const cards = await repo.allCards();
    expect(cards).toHaveLength(2);
    const twin = cards.find((card) => card.direction === 'production')!;
    expect(twin.context?.source).toBe('reverse');
    expect(isExplicitAdd(twin)).toBe(true);

    // The day's allowance is exactly where it was before the press.
    const after = buildQueue({ now, cards, settings });
    expect(after.chargedToday).toBe(1);
    expect(after.drawLimit).toBe(9);

    // And the inherited source is demonstrably the thing that made the
    // difference: the same twin carrying `list` takes a slot today…
    const inherited = [spine, withSource(twin, 'list')];
    expect(buildQueue({ now, cards: inherited, settings }).drawLimit).toBe(8);
    // …and, still ungraded, another one tomorrow, as backlog. Tomorrow the
    // spine card is itself a slot of backlog, so the honest comparison is the
    // difference between the two: one card, one slot, every day it sits there.
    expect(buildQueue({ now: now + DAY, cards: inherited, settings }).drawLimit).toBe(8);
    expect(buildQueue({ now: now + DAY, cards: [spine, twin], settings }).drawLimit).toBe(9);
  });
});
