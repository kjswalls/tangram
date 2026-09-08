/**
 * Phase 6 item 1 — i+1 example sentences on the back of a review card.
 *
 * The demo is the fixture, because the feature is about a learner who already
 * knows something: `?seed=demo` declares HSK 1–2 known and leaves eight band-3
 * cards due, which is exactly the shape "words you know, plus one you don't"
 * needs. What is asserted here and nowhere else:
 *
 *  - the **flip is never blocked** by the sentences (proved by delaying the
 *    route and reading the back while the request is still in flight);
 *  - every character on screen belongs to a word the learner knows, or to the
 *    card's own word — the promise the whole feature makes, checked against the
 *    learner's actual `known_words` rather than against the filter's own idea
 *    of itself;
 *  - a repeat is served from `ask_cache` without asking again;
 *  - the toggle removes the block entirely rather than hiding it.
 */
import { expect, test, type Page } from '@playwright/test';

import { ready, resetApp } from '../p3/helpers';

/** The demo learner: HSK 1–2 known, eight cards due, provenance on them. */
async function loadDemo(page: Page): Promise<void> {
  await resetApp(page);
  await page.goto('/?seed=demo');
  await expect(page).toHaveURL(/\/$/, { timeout: 120_000 });
  await expect(page.getByTestId('today-due-count')).not.toHaveText('—', { timeout: 120_000 });
}

async function openReview(page: Page): Promise<void> {
  await page.goto('/review');
  await ready(page);
  await expect(page.getByTestId('review-card')).toBeVisible({ timeout: 60_000 });
}

/** `trad|simp[pinyin]` → `simp`, the same split `parseEntryId` makes. */
function simpOf(entryId: string): string {
  return entryId.split('|')[1]?.split('[')[0] ?? '';
}

test.describe('example sentences on the card back', () => {
  test('arrive after the flip, never before it, and are built only from known words', async ({
    page,
  }) => {
    await loadDemo(page);

    // Hold the sentences back for three seconds. The card must not wait.
    await page.route('**/api/examples', async (route) => {
      if (route.request().method() === 'POST') {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      await route.continue();
    });

    await openReview(page);
    const cardId = await page.getByTestId('review-card').getAttribute('data-card-id');
    expect(cardId).toBeTruthy();

    await page.keyboard.press('Space');
    // The answer is on screen while the sentences are still being fetched:
    // reading, glosses and the four grade buttons, none of them waiting.
    await expect(page.getByTestId('card-back')).toBeVisible({ timeout: 2_000 });
    await expect(page.getByTestId('card-pinyin')).toBeVisible();
    await expect(page.getByTestId('grade-3')).toBeEnabled();
    await expect(page.getByTestId('example-sentences')).toHaveAttribute('data-status', 'loading');

    const sentences = page.getByTestId('example-sentences');
    await expect(sentences).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });

    // Either sentences or the quiet empty line — both are answers.
    const list = page.getByTestId('examples-list');
    const empty = page.getByTestId('examples-empty');
    expect((await list.count()) + (await empty.count())).toBe(1);
    // The demo learner knows a thousand words, so there is something to build with.
    await expect(list).toBeVisible();

    const tokens = page.getByTestId('example-token');
    expect(await tokens.count()).toBeGreaterThan(0);

    const ids = await tokens.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-entry-id') ?? ''),
    );
    const knownSimps = new Set(
      await page.evaluate(async () =>
        (await window.__tangram.repo.knownEntryIds()).map(
          (id) => id.split('|')[1]?.split('[')[0] ?? '',
        ),
      ),
    );
    const card = await page.evaluate(
      async (id) => (await window.__tangram.repo.allCards()).find((row) => row.id === id),
      cardId,
    );
    const targetSimp = card?.snapshot.simp ?? '';
    expect(targetSimp).not.toBe('');

    for (const id of ids) {
      expect(id).not.toBe('');
      const simp = simpOf(id);
      // The one word the sentence is allowed to teach is the card's own.
      expect(knownSimps.has(simp) || simp === targetSimp).toBe(true);
    }
    // …and the card's word is actually in the sentence, or it is not an example.
    expect(ids.map(simpOf)).toContain(targetSimp);
  });

  test('a repeat is served from the cache without asking again', async ({ page }) => {
    await loadDemo(page);

    let asks = 0;
    await page.route('**/api/examples', async (route) => {
      if (route.request().method() === 'POST') asks += 1;
      await route.continue();
    });

    await openReview(page);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('examples-list')).toBeVisible({ timeout: 60_000 });
    expect(asks).toBe(1);
    await expect(page.getByTestId('example-sentences')).toHaveAttribute('data-cached', 'false');

    // The same card again, from a fresh page: the row is in `ask_cache`, keyed
    // in the browser, so nothing goes back to the provider.
    await openReview(page);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('example-sentences')).toHaveAttribute('data-cached', 'true', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('examples-list')).toBeVisible();
    expect(asks).toBe(1);
  });

  test('the settings toggle takes the block off the card entirely', async ({ page }) => {
    await loadDemo(page);
    await page.evaluate(() => window.__tangram.repo.setSettings({ examplesOnBack: false }));

    await openReview(page);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toBeVisible();
    await expect(page.getByTestId('card-glosses')).toBeVisible();
    // Not hidden: not rendered, and nothing was asked for.
    await expect(page.getByTestId('example-sentences')).toHaveCount(0);
    await expect(page.getByTestId('card-examples')).toHaveCount(0);
  });
});
