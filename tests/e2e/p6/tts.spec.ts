/**
 * Phase 6 — the speaker button (PLAN.md §3.6).
 *
 * Headless Chromium ships **no** speech-synthesis voices, so the only thing
 * this container can observe is the unavailable branch. That is deliberate and
 * it is the whole spec: the button is present on both surfaces, it is disabled,
 * and it says why. Audio itself is unverified here (HANDOFF.md, Phase 6).
 */
import { expect, test } from '@playwright/test';

import { DASUAN, openReview, seed } from '../p2/fixtures';

const NO_VOICE = 'No Mandarin voice available in this browser';

test.describe('speaker button', () => {
  test('is on the review card back, disabled, with the reason', async ({ page }) => {
    await openReview(page);
    await seed(page, [{ entry: DASUAN, gradedDaysAgo: 30 }]);

    await expect(page.getByTestId('card-back')).toHaveCount(0);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toBeVisible();

    const speak = page.getByTestId('card-back').getByTestId('speak-button');
    await expect(speak).toBeVisible();
    await expect(speak).toBeDisabled();
    await expect(speak).toHaveAttribute('data-tts-status', 'unavailable');
    await expect(speak).toHaveAttribute('title', NO_VOICE);
    await expect(speak).toHaveAttribute('aria-label', NO_VOICE);
  });

  test('is in the lookup entry detail, disabled, with the reason', async ({ page }) => {
    await page.goto('/lookup');
    await page.getByTestId('lookup-input').fill('dasuan');
    const first = page.getByTestId('search-result').first();
    await expect(first).toContainText('打算', { timeout: 20_000 });
    await first.click();

    const detail = page.getByTestId('entry-detail');
    await expect(detail).toBeVisible();
    const speak = detail.getByTestId('speak-button');
    await expect(speak).toBeVisible();
    await expect(speak).toBeDisabled();
    await expect(speak).toHaveAttribute('data-tts-status', 'unavailable');
    await expect(speak).toHaveAttribute('title', NO_VOICE);
  });
});
