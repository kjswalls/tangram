/**
 * The demo seed through the URL (PLAN.md §4 P3): `/?seed=demo` leaves a learner
 * mid-course — cards waiting, provenance on them, something to read.
 */
import { expect, test } from '@playwright/test';

import { resetApp } from './helpers';

test.describe('?seed=demo', () => {
  test('loads a worked example and hands Today a real queue', async ({ page }) => {
    await resetApp(page);
    await page.goto('/?seed=demo');

    // The handler seeds, then drops the parameter and starts over on the result.
    await expect(page).toHaveURL(/\/$/, { timeout: 120_000 });
    const due = page.getByTestId('today-due-count');
    await expect(due).not.toHaveText('—', { timeout: 120_000 });
    expect(Number(await due.innerText())).toBeGreaterThanOrEqual(3);

    const state = await page.evaluate(async () => {
      const { repo, db } = window.__tangram;
      const now = Date.now();
      const dueCards = await repo.listDue(now);
      return {
        due: dueCards.length,
        withSentence: dueCards.filter((card) => card.context?.sentence).length,
        sources: [...new Set((await repo.allCards()).map((card) => card.context?.source))],
        known: (await repo.knownEntryIds()).length,
        texts: (await repo.texts()).length,
        askCache: await db.table('ask_cache').count(),
      };
    });

    expect(state.due).toBeGreaterThanOrEqual(3);
    // /review has provenance to show: a due card carrying the sentence it came from.
    expect(state.withSentence).toBeGreaterThanOrEqual(1);
    for (const source of ['lookup', 'ask', 'reader', 'list']) {
      expect(state.sources).toContain(source);
    }
    expect(state.known).toBeGreaterThan(1000);
    expect(state.texts).toBe(1);
    expect(state.askCache).toBe(2);
  });

  test('the settings page loads and wipes the same demo', async ({ page }) => {
    await resetApp(page);
    await page.goto('/settings');
    await page.getByTestId('load-demo').click();
    await page.getByTestId('load-demo').click();
    await expect(page.getByTestId('settings-status')).toContainText('Demo loaded', {
      timeout: 120_000,
    });

    await page.getByTestId('reset-all').click();
    await page.getByTestId('reset-all').click();
    await expect(page.getByTestId('settings-status')).toContainText('wiped', { timeout: 60_000 });
    expect(await page.evaluate(() => window.__tangram.repo.allCards())).toEqual([]);
  });
});
