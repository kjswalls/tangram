/**
 * The Look up tab's three answer states (docs/plans/core.md C7;
 * product-decisions §5).
 *
 * The happy path already had a spec (`p4/ask.spec.ts`). These are the other
 * three, and C7 asks for them by name because they are what makes the grounding
 * promise *visible* rather than merely true:
 *
 *   1. **thinking** — the dictionary card is rendered and addable before the
 *      model returns. The answer never blocks the add.
 *   2. **unavailable** — a quiet chip, and everything else still works.
 *   3. **ungrounded** — an `EmptyState` saying nothing could be checked, no
 *      phrase cards at all, and the real words inside the rejected phrases
 *      still addable from the dictionary card above.
 *
 * Each one is forced at the network boundary rather than through a test hook,
 * because the state the learner sees is a property of what came back over the
 * wire; a hook that sets the state directly would pass against a panel that
 * could never enter it.
 *
 * **The route cannot produce case 3 on its own, deliberately.** `app/api/ask`
 * substitutes a retrieval echo when grounding kills every proposal (§3.4's "no
 * query ever renders an empty panel"), so the panel's `ungrounded` branch is
 * reachable only when even the echo grounds to nothing. That is rare and it is
 * still a state the panel must render correctly, which is exactly what an
 * intercepted response is for. Recorded in HANDOFF.md.
 */
import { expect, type Page, test } from '@playwright/test';

import { ASK_OFFLINE_CHIP, ASK_UNGROUNDED_TITLE } from '@/components/lookup/ask-state';

import { expectBaseText } from '../hanzi';
import { resetApp } from '../p3/helpers';

/** 打算 — in every band of the dictionary, so the lookup half never flakes. */
const QUERY = '打算';

const panel = (page: Page) => page.getByTestId('ask-panel');

async function lookUp(page: Page, query: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('lookup-input').fill(query);
  await expect(page.getByTestId('search-result').first()).toBeVisible({ timeout: 20_000 });
}

test.describe('the Look up tab’s three answer states', () => {
  test.beforeEach(async ({ page }) => {
    // The spine would otherwise put ten HSK words in front of the one card
    // these specs add.
    await resetApp(page, { newPerDay: 0 });
  });

  test('thinking: the dictionary card is addable before the model returns', async ({ page }) => {
    // Hold the model call open for the whole test. Nothing releases it — the
    // point is that nothing on the dictionary side was ever waiting for it.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/ask', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await held;
      await route.abort();
    });

    await lookUp(page, QUERY);
    await page.getByTestId('search-result').first().click();
    await expect(page.getByTestId('entry-detail')).toBeVisible();

    // The answer is out and unfinished…
    await expect(panel(page)).toHaveAttribute('data-ask-state', 'thinking', { timeout: 20_000 });
    await expect(page.getByTestId('ask-ai-chip')).toBeVisible();

    // …and the card goes in anyway, while it is still pending.
    const add = page.getByTestId('add-card');
    await expect(add).toBeEnabled();
    await add.click();
    await expect(page.getByTestId('add-state')).toContainText('Added');
    expect(await cardCount(page)).toBe(1);

    // Still thinking: the add did not resolve, cancel or depend on the answer.
    await expect(panel(page)).toHaveAttribute('data-ask-state', 'thinking');
    release?.();
  });

  test('unavailable: a quiet chip, and the dictionary still answers', async ({ page }) => {
    await page.route('**/api/ask', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.abort('internetdisconnected');
    });

    await lookUp(page, QUERY);
    // The dictionary half is untouched — that is the half of "everything else
    // works" a status-only assertion would miss.
    // Through `baseText`: C3's per-character ruby interleaves the readings into
    // `textContent`, so a plain `toContainText('打算')` reads `打dǎ算suàn`.
    await expectBaseText(page.getByTestId('search-result').first(), '打算');
    await page.getByTestId('search-result').first().click();
    await expect(page.getByTestId('entry-detail')).toBeVisible();

    await expect(panel(page)).toHaveAttribute('data-ask-state', 'unavailable', { timeout: 40_000 });
    await expect(page.getByTestId('ask-offline-chip')).toHaveText(ASK_OFFLINE_CHIP);

    // …and the add still works with no AI at all.
    await page.getByTestId('add-card').click();
    await expect(page.getByTestId('add-state')).toContainText('Added');
    expect(await cardCount(page)).toBe(1);
  });

  test('ungrounded: nothing could be checked, no phrase cards, words still addable', async ({
    page,
  }) => {
    await page.route('**/api/ask', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      // Every proposal rejected: this is the body the route would have built
      // if its own echo fallback had also grounded to nothing.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'fake',
          promptVersion: 'v1',
          query: QUERY,
          dictVersion: 'test',
          response: { interpretation: '', matches: [], sayIt: [], notes: [] },
          entries: [],
          retrieved: 0,
          cacheable: false,
        }),
      });
    });

    await lookUp(page, QUERY);
    await page.getByTestId('search-result').first().click();
    await expect(page.getByTestId('entry-detail')).toBeVisible();

    await expect(panel(page)).toHaveAttribute('data-ask-state', 'ungrounded', { timeout: 20_000 });
    // It says so, in an EmptyState rather than an empty answer body.
    await expect(page.getByTestId('ask-ungrounded')).toContainText(ASK_UNGROUNDED_TITLE);
    // …and shows nothing it could not check.
    await expect(page.getByTestId('ask-sayits')).toHaveCount(0);
    await expect(page.getByTestId('ask-matches')).toHaveCount(0);
    await expect(page.getByTestId('ask-interpretation')).toHaveCount(0);

    // product-decisions §5: the real words are still addable. The dictionary
    // card is where they come from, and grounding rejecting an answer has no
    // say over it.
    await page.getByTestId('add-card').click();
    await expect(page.getByTestId('add-state')).toContainText('Added');
    expect(await cardCount(page)).toBe(1);

    // A rejected answer is never cached: the next ask must reach the provider
    // again rather than repeat this for as long as the row lives.
    expect(await askCacheSize(page)).toBe(0);
  });
});

function cardCount(page: Page): Promise<number> {
  return page.evaluate(async () => (await window.__tangram.repo.allCards()).length);
}

function askCacheSize(page: Page): Promise<number> {
  return page.evaluate(async () => (await window.__tangram.db.ask_cache.toArray()).length);
}
