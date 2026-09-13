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

/**
 * Is each of these entries one the learner knows — by the app's own rule, not
 * by the filter's idea of itself?
 *
 * `wordState` (lib/srs/states.ts) restated in the browser, deliberately: a
 * declared `known_words` row, else the card's own state (Review, stability ≥
 * 21 days), else the band assumption for a word with no card. Compared **by
 * entry id**, because 看 kàn and 看 kān are two words that share their
 * characters and only one of them may have been met.
 */
async function knownVerdicts(page: Page, ids: string[]): Promise<string[]> {
  return page.evaluate(async (wanted: string[]) => {
    const repo = window.__tangram.repo;
    const [known, cards, settings] = await Promise.all([
      repo.knownEntryIds(),
      repo.allCards(),
      repo.getSettings(),
    ]);
    const declared = new Set(known);
    const byEntry = new Map(
      cards.filter((card) => card.entryId).map((card) => [card.entryId as string, card]),
    );
    const query = wanted.map((id) => `ids=${encodeURIComponent(id)}`).join('&');
    const response = await fetch(`/api/dict/entries?${query}`);
    const bands = new Map<string, number | undefined>(
      ((await response.json()).entries as { id: string; hskBand?: number }[]).map((entry) => [
        entry.id,
        entry.hskBand,
      ]),
    );
    return wanted.map((id) => {
      if (declared.has(id)) return 'known';
      const card = byEntry.get(id);
      if (card) return card.fsrs.state === 2 && card.fsrs.stability >= 21 ? 'known' : 'learning';
      const band = bands.get(id);
      return band !== undefined && band <= settings.knownBand ? 'known' : 'new';
    });
  }, ids);
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
    const card = await page.evaluate(
      async (id) => (await window.__tangram.repo.allCards()).find((row) => row.id === id),
      cardId,
    );
    const targetId = card?.entryId ?? '';
    expect(targetId).not.toBe('');

    // Compared by **entry id**, never by characters: a check on the simplified
    // form passes for a reading the learner has never met (看 kàn / 看 kān), and
    // the reading is what a learner cannot check for themselves.
    const verdicts = await knownVerdicts(page, ids);
    for (const [index, id] of ids.entries()) {
      expect(id).not.toBe('');
      // The one word the sentence is allowed to teach is the card's own.
      if (id === targetId) continue;
      expect(verdicts[index], `${id} is on the back of the card`).toBe('known');
    }
    // …and the card's word is actually in the sentence, or it is not an example.
    expect(ids).toContain(targetId);
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

  test('leaves the grade buttons reachable on a phone, under the whole block', async ({
    page,
  }) => {
    // The block is on by default and it is tall: glosses, sentences, the
    // context box. On a 390×844 screen that used to put the four grade buttons
    // 300px below the fold — and a phone has no keyboard, so 1–4 is not an
    // escape. They dock to the bottom of the viewport instead.
    await page.setViewportSize({ width: 390, height: 844 });
    await loadDemo(page);
    await openReview(page);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toBeVisible();
    await expect(page.getByTestId('example-sentences')).toHaveAttribute('data-status', 'ready', {
      timeout: 60_000,
    });

    const bar = page.getByTestId('grade-bar');
    await expect(bar).toBeInViewport();
    const box = await bar.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844);
    // And it still grades from where it sits.
    await page.getByTestId('grade-3').click();
    await expect(page.getByTestId('review-card')).toBeVisible();
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
