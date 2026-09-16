/**
 * Phase 6 — the speaker button (PLAN.md §3.6).
 *
 * Headless Chromium ships **no** speech-synthesis voices, so the only thing
 * this container can observe is the unavailable branch. That is deliberate and
 * it is the whole spec: the button is present on both surfaces, it is disabled,
 * and it says why. Audio itself is unverified here (HANDOFF.md, Phase 6).
 */
import { expect, test } from '../dict';

import { DASUAN, openReview, seed } from '../p2/fixtures';

import { expectBaseText } from '../hanzi';

const NO_VOICE = 'No Mandarin voice available in this browser';
/**
 * The short form that sits next to the glyph. **This is the assertion C2's
 * criterion actually asks for**: "the disabled state and its *visible* reason".
 * The spec asserted `title` and `aria-label` only — i.e. the reason exactly
 * where a touch screen never shows it, which is the failure the component's
 * header says the visible text exists to prevent.
 */
const NO_VOICE_VISIBLE = 'No voice';

/**
 * **This spec needs a dictionary on the device**, so it accepts the ask once
 * before each test — `tests/e2e/dict.ts`, which is also where the next person
 * to change this behaviour changes it. The default there is `'ask'`, a fresh
 * origin with nothing stored, because that is what a fresh origin really gets
 * now that `<DictGate>`'s mount probes instead of downloading.
 */
test.use({ dictionary: 'installed' });

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
    await expect(
      page.getByTestId('card-back').getByText(NO_VOICE_VISIBLE, { exact: true }),
    ).toBeVisible();
  });

  test('is in the lookup entry detail, disabled, with the reason', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('lookup-input').fill('dasuan');
    const first = page.getByTestId('search-result').first();
    await expectBaseText(first, '打算', { timeout: 20_000 });
    await first.click();

    const detail = page.getByTestId('entry-detail');
    await expect(detail).toBeVisible();
    const speak = detail.getByTestId('speak-button');
    await expect(speak).toBeVisible();
    await expect(speak).toBeDisabled();
    await expect(speak).toHaveAttribute('data-tts-status', 'unavailable');
    await expect(speak).toHaveAttribute('title', NO_VOICE);
    await expect(detail.getByText(NO_VOICE_VISIBLE, { exact: true })).toBeVisible();
  });
});
