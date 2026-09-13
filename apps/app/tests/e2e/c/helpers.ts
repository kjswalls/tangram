import type { Page } from '@playwright/test';

import type { SettingsRow } from '@/lib/db';

/** The layout mounts the test hook in an effect, so a fresh page has to wait. */
export async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => '__tangram' in window);
}

/**
 * A clean database for a spec. `/settings` is the one route that neither draws
 * new cards nor materialises a list, so wiping from there cannot race the page
 * (the same reason `tests/e2e/p3/helpers.ts` resets from there).
 */
export async function resetApp(page: Page, settings?: Partial<SettingsRow>): Promise<void> {
  await page.goto('/settings');
  await ready(page);
  await page.evaluate(async (patch) => {
    await window.__tangram.repo.resetAll();
    if (patch) await window.__tangram.repo.setSettings(patch);
  }, settings);
}
