import type { Page } from '@playwright/test';

import type { SettingsRow } from '@/lib/db';

/** The layout mounts the hook in an effect, so a fresh page has to wait for it. */
export async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => '__tangram' in window);
}

/**
 * A clean database for a spec. `/settings` is the one route that neither draws
 * new cards nor materialises a list, so wiping from there cannot race the page.
 */
export async function resetApp(page: Page, settings?: Partial<SettingsRow>): Promise<void> {
  await page.goto('/settings');
  await ready(page);
  await page.evaluate(async (patch) => {
    await window.__tangram.repo.resetAll();
    if (patch) await window.__tangram.repo.setSettings(patch);
  }, settings);
}

/** Grade every card that is currently new, as if a review session had run. */
export async function gradeAllNew(page: Page, rating: 1 | 2 | 3 | 4 = 3): Promise<number> {
  await ready(page);
  return page.evaluate(async (value) => {
    const repo = window.__tangram.repo;
    const fresh = (await repo.allCards()).filter((card) => card.fsrs.state === 0);
    for (const card of fresh) await repo.grade(card.id, value);
    return fresh.length;
  }, rating);
}
