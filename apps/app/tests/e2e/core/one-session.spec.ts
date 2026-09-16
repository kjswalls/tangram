/**
 * One session serves all three (docs/plans/core.md C7; `wave-zero.md` §9).
 *
 * product-decisions §1's central claim is that learning a new word, recognising
 * it and writing it are **one** session. Before C7 they were not: Today
 * introduced the day's new words on one screen and `/review` served the queue on
 * another, so "one session" was a claim about two screens.
 *
 * C7's criterion is deliberately behavioural rather than structural: from a
 * fresh database with new words available and reviews due **in both
 * directions**, starting Practice once has to reach a new word, a recognition
 * item and a write item *without leaving the Practice tab* — and end in one
 * completion state. The unit half (`tests/unit/srs/merged-session.test.ts`)
 * proves the three properties a merge could quietly break; this half proves the
 * learner actually meets all three kinds in one sitting.
 *
 * **The URL is the assertion, not scenery.** Every step records `page.url()`,
 * and the run fails if it ever leaves `/practice`. A merge that regressed into
 * "go to Today first" would otherwise still pass a spec that simply walked the
 * cards.
 *
 * **Why the new word is an explicit add rather than a spine draw.** The draw
 * reads the band lists, which a fresh database materialises in the background,
 * so how many words it yields on the *first* load of Practice is a race — the
 * run that made this note got one card out of a cap of three, on a different
 * load each time. An explicit add is a first-class way a new word enters
 * today's queue (`lib/lists/queue.ts`: "an explicitly added card is *always* in
 * today's queue; `newPerDay` caps the spine auto-draw only"), and it produces
 * the same `state: New` row the draw would have. It is explicit by its
 * `context.source`, which is the only thing `isExplicitAdd` reads — a card
 * seeded without one is capped like a spine draw, and with `newPerDay: 0` it
 * silently never appears. That is how this spec first failed.
 *
 * That the Practice tab is where the *day's cap* is introduced, with no visit
 * to Today, is `tests/e2e/p3/today.spec.ts` and
 * `tests/unit/srs/merged-session.test.ts`.
 */
import { expect, test, type Page } from '@playwright/test';

import { DASUAN, KANKAN } from '../p2/fixtures';
import { ready } from '../p3/helpers';

/** What the learner is looking at right now, in the terms the criterion uses. */
interface Seen {
  /** A new word is new whichever way round it is asked, so it wins over direction. */
  kind: 'new' | 'recognition' | 'production';
  id: string;
  state: number | undefined;
}

/**
 * Every card's FSRS state **at the moment the session opened**.
 *
 * "Is this a new word?" has to be asked of the session's starting state, not of
 * the row as the walk reaches it. A session serves learning steps, so states
 * move while it runs, and reading the row at the moment a card appears answers
 * a different question — the run that made this note read a never-graded card
 * as `Learning`, because by the time the walk reached it the session had
 * already put it through a step. Taken once, before a single grade, this cannot
 * drift.
 */
async function statesAtStart(page: Page): Promise<Record<string, number>> {
  return page.evaluate(async () => {
    const rows = await window.__tangram.repo.allCards();
    return Object.fromEntries(rows.map((row) => [row.id, row.fsrs.state]));
  });
}

async function currentCard(page: Page, atStart: Record<string, number>): Promise<Seen> {
  const card = page.getByTestId('review-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  const id = (await card.getAttribute('data-card-id'))!;
  const direction = (await card.getAttribute('data-direction')) as 'recognition' | 'production';
  // A new word is new whichever way round it is asked, so `New` wins over the
  // direction attribute.
  return { kind: atStart[id] === 0 ? 'new' : direction, id, state: atStart[id] };
}

/** Reveal and grade, whichever of the two card shapes is on screen. */
async function answer(page: Page, rating: 3 | 4): Promise<void> {
  await page.getByTestId('reveal').click({ timeout: 10_000 });
  await expect(page.getByTestId('card-back')).toBeVisible();
  await page.getByTestId(`grade-${rating}`).click();
}

/** Is the session still offering a card? */
async function hasCard(page: Page): Promise<boolean> {
  if ((await page.getByTestId('review-empty').count()) > 0) return false;
  return (await page.getByTestId('review-card').count()) > 0;
}

/**
 * A fresh database with reviews due in both directions and one word the learner
 * has never seen. 看看 is deliberately the same word in two states — its
 * production twin due, its recognition card new — which also exercises
 * `spaceDirections`, since the answer to one is on the back of the other.
 */
async function seedSession(page: Page): Promise<void> {
  await page.goto('/practice');
  await page.waitForFunction(() => Boolean(window.__tangram));
  await page.evaluate(
    async ([dasuan, kankan]) => {
      const repo = window.__tangram.repo;
      await repo.resetAll();
      // No spine draw: every card below is one this spec put there, so the
      // walk is the same every run.
      await repo.setSettings({ newPerDay: 0, productionDirection: true });
      const month = Date.now() - 30 * 86_400_000;
      const recognition = await repo.addCardFromEntry(
        dasuan as never, undefined, undefined, undefined, 'recognition',
      );
      const production = await repo.addCardFromEntry(
        kankan as never, undefined, undefined, undefined, 'production',
      );
      await repo.grade(recognition.id, 3, month);
      await repo.grade(production.id, 3, month);
      // Never graded, and added by hand — the two things that make it a new
      // word the session must offer.
      await repo.addCardFromEntry(
        kankan as never,
        { source: 'lookup', addedAt: Date.now() },
        undefined,
        undefined,
        'recognition',
      );
    },
    [DASUAN, KANKAN] as const,
  );
}

test.describe('the Practice tab is one session', () => {
  // A whole session, card by card. The default 30 s is a per-*test* budget, not
  // a per-step one.
  test.setTimeout(180_000);

  test('reaches a new word, a recognition item and a write item without leaving it', async ({
    page,
  }) => {
    await seedSession(page);

    // Start Practice **once**. Nothing below navigates again.
    await page.goto('/practice');
    await ready(page);
    await expect(page.getByTestId('review-session')).toBeVisible({ timeout: 30_000 });

    const atStart = await statesAtStart(page);
    // The session genuinely has a word the learner has never seen in it.
    expect(Object.values(atStart).filter((state) => state === 0)).toHaveLength(1);

    const urls = new Set<string>();
    const seen: Seen[] = [];
    const kinds = () => new Set(seen.map((card) => card.kind));
    for (let step = 0; step < 40 && kinds().size < 3; step += 1) {
      urls.add(new URL(page.url()).pathname);
      if (!(await hasCard(page))) break;
      seen.push(await currentCard(page, atStart));
      if (kinds().size === 3) break;
      // The session can end under the loop — grading the last card swaps the
      // card for the completion state — so a vanished control ends the walk
      // rather than timing it out. What was met is the assertion below.
      try {
        await answer(page, 3);
      } catch {
        break;
      }
    }

    // All three, in one sitting. What was met is in the failure message,
    // because a failure here is always "which one was missing, and what came
    // instead".
    expect([...kinds()].sort(), JSON.stringify(seen)).toEqual([
      'new',
      'production',
      'recognition',
    ]);
    // …and never anywhere but Practice. No Today, no second screen.
    expect([...urls]).toEqual(['/practice']);
  });

  test('ends in one completion state, still on the Practice tab', async ({ page }) => {
    // The other half of "one session": it finishes once, rather than emptying
    // one screen and leaving work on another.
    await seedSession(page);

    await page.goto('/practice');
    await ready(page);
    await expect(page.getByTestId('review-session')).toBeVisible({ timeout: 30_000 });

    // "Instant" on every card, so nothing comes back inside the session.
    for (let step = 0; step < 12 && (await hasCard(page)); step += 1) {
      try {
        await answer(page, 4);
      } catch {
        break;
      }
    }

    await expect(page.getByTestId('review-empty')).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).pathname).toBe('/practice');
    // One completion state, not two: nothing sends the learner to a second
    // screen to finish.
    await expect(page.getByTestId('review-session')).toHaveCount(0);
  });
});
