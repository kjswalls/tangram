/**
 * The gallery (docs/plans/core.md C1).
 *
 * It is the surface every later phase is reviewed on, so this spec is as much
 * about *it still being there and still legible* as about any one primitive:
 * it loads at both breakpoints in both themes, it never scrolls sideways at
 * 390px, it keeps a 16px gutter, every interactive thing is reachable by Tab
 * without focus landing somewhere invisible, and the composite states C4a and
 * C7 will assert against are all present under the ids those phases use.
 *
 * `tests/e2e/core/gallery-excluded.spec.ts` is the other half: it proves a
 * production build has no gallery at all.
 */
import { expect, test, type Page } from '@playwright/test';

const PHONE = { width: 390, height: 844 };
const DESK = { width: 1280, height: 800 };

/** Every composite state C4a's and C7's specs will name. */
const DICT_KEYS = [
  'absent',
  'preparing',
  'preparing-indeterminate',
  'ready',
  'failed-download',
  'failed-import',
  'failed-storage',
  'failed-corrupt',
  // The native first-launch copy and its low-storage failure. C1 names them
  // among the composite states "so no later phase can quietly skip them", and
  // `ios.md` register #18 and `android.md` A5 both wait on them.
  'asset-absent',
  'asset-preparing',
  'asset-failed-storage',
] as const;
const ASK_STATES = ['idle', 'thinking', 'unavailable', 'ungrounded'] as const;

async function setTheme(page: Page, theme: string): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
}

test.describe('the gallery', () => {
  for (const [name, size] of [
    ['phone', PHONE],
    ['desktop', DESK],
  ] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`renders every section at ${name} in ${theme}`, async ({ page }, testInfo) => {
        await page.setViewportSize(size);
        await page.goto('/gallery');
        await setTheme(page, theme);
        await expect(page.getByTestId('gallery')).toBeVisible();

        const sections = page.getByTestId('gallery-section');
        const count = await sections.count();
        expect(count).toBeGreaterThanOrEqual(8);

        for (let i = 0; i < count; i += 1) {
          const section = sections.nth(i);
          const key = await section.getAttribute('data-section');
          await testInfo.attach(`${name}-${theme}-${key}`, {
            body: await section.screenshot(),
            contentType: 'image/png',
          });
        }
      });
    }
  }

  test('does not scroll sideways at 390px, and keeps a 16px gutter', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/gallery');
    await expect(page.getByTestId('gallery')).toBeVisible();

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

    // The gutter is the app shell's `<main>` padding; assert the rendered box
    // rather than the class, because a class can be overridden downstream.
    const box = await page.getByTestId('gallery').boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? 0).toBeGreaterThanOrEqual(16);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE.width - 16);
  });

  test('renders the dictionary states and the ask states under the ids C4a and C7 use', async ({
    page,
  }) => {
    await page.goto('/gallery');
    for (const key of DICT_KEYS) {
      await expect(page.getByTestId(`dict-state-${key}`)).toBeVisible();
    }
    // `ready` is the state with no screen: its wrapper is there, the component is not.
    await expect(
      page.getByTestId('dict-state-ready').getByTestId('dict-status'),
    ).toHaveCount(0);
    // The four reasons are distinguishable, not one generic failure.
    for (const reason of ['download', 'import', 'storage', 'corrupt']) {
      await expect(
        page.getByTestId(`dict-state-failed-${reason}`).locator('[data-reason]'),
      ).toHaveAttribute('data-reason', reason);
    }
    // The determinate bar is determinate — an indeterminate spinner here is a
    // defect, not a simplification (data.md D4).
    const bar = page.getByTestId('dict-state-preparing').getByTestId('dict-progress-bar');
    await expect(bar).toHaveAttribute('role', 'progressbar');
    await expect(bar).toHaveAttribute('aria-valuenow', /\d/);
    await expect(bar).toHaveAttribute('aria-valuemax', /\d/);
    // The bar is the app's, not the UA's: an unstyled `<progress>` is pure
    // green in Chromium and something else in every other engine, on the first
    // screen of a first launch.
    await expect(
      page.getByTestId('dict-state-preparing').getByTestId('dict-progress-fill'),
    ).toHaveCSS('background-color', 'rgb(15, 118, 110)');
    await expect(
      page.getByTestId('dict-state-preparing').getByTestId('dict-progress'),
    ).toHaveAttribute('data-determinate', 'true');
    await expect(
      page.getByTestId('dict-state-preparing-indeterminate').getByTestId('dict-progress'),
    ).toHaveAttribute('data-determinate', 'false');

    // The native copy says different words from the download, and says which.
    const assetPreparing = page.getByTestId('dict-state-asset-preparing');
    await expect(assetPreparing.getByTestId('dict-progress')).toHaveAttribute(
      'data-determinate',
      'true',
    );
    await expect(assetPreparing.locator('[data-source]')).toHaveAttribute('data-source', 'asset');
    await expect(
      page.getByTestId('dict-state-asset-failed-storage').locator('[data-reason]'),
    ).toHaveAttribute('data-reason', 'storage');
    expect(
      await page.getByTestId('dict-state-asset-absent').getByTestId('dict-status').textContent(),
    ).not.toBe(await page.getByTestId('dict-state-absent').getByTestId('dict-status').textContent());

    for (const state of ASK_STATES) {
      await expect(page.getByTestId(`ask-state-${state}`)).toBeVisible();
    }
    await expect(page.getByTestId('ask-offline-chip')).toHaveText('Dictionary only — offline');
    await expect(page.getByTestId('ask-ungrounded')).toBeVisible();
  });

  test('every interactive control is reachable by Tab, visible, and shows the focus ring', async ({
    page,
  }) => {
    await page.setViewportSize(DESK);
    await page.goto('/gallery');
    await expect(page.getByTestId('gallery')).toBeVisible();

    const total = await page.locator('button:not([disabled]), a[href], input:not([disabled])').count();
    expect(total).toBeGreaterThan(20);

    const seen = new Set<string>();
    for (let i = 0; i < total + 10; i += 1) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          key: `${el.tagName}#${el.id}.${el.className}:${(el.textContent ?? '').slice(0, 20)}`,
          w: rect.width,
          h: rect.height,
          visibility: style.visibility,
          display: style.display,
          outlineStyle: style.outlineStyle,
          outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
        };
      });
      if (!info) continue;
      // The whole point: focus must never land on something with no box or no
      // visibility. A trap or a `sr-only` control is how that happens.
      expect(info.w, `focused element ${info.key} has no width`).toBeGreaterThan(0);
      expect(info.h, `focused element ${info.key} has no height`).toBeGreaterThan(0);
      expect(info.visibility).not.toBe('hidden');
      expect(info.display).not.toBe('none');
      // The other half of C1's criterion, and the half that was computed and
      // then thrown away: the `:focus-visible` ring must actually be painted.
      // `focus:outline-none` on a single primitive is how it stops being, and
      // `input.tsx` shipped exactly that until this assertion existed.
      expect(info.outlineStyle, `${info.key} has no focus ring`).not.toBe('none');
      expect(info.outlineWidth, `${info.key} has a 0px focus ring`).toBeGreaterThan(0);
      seen.add(info.key);
    }
    expect(seen.size).toBeGreaterThan(20);
  });

  test('the sheet opens, traps, and closes on Escape', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/gallery');
    await page.getByTestId('gallery-open-sheet').click();

    const sheet = page.getByTestId('gallery-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('aria-modal', 'true');

    // At 390px it covers the lower two thirds, so the tapped thing above it
    // stays visible — §1's layout fact, asserted rather than intended.
    const box = await sheet.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height ?? 0).toBeLessThanOrEqual(PHONE.height * 0.67);

    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    // Focus goes back to the opener, which is what makes Escape usable twice.
    await expect(page.getByTestId('gallery-open-sheet')).toBeFocused();
  });

  test('the theme control drives the page, including the unset default', async ({ page }) => {
    await page.goto('/gallery');
    const ground = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.getByTestId('gallery-theme-dark').click();
    const dark = await ground();
    await page.getByTestId('gallery-theme-unset').click();
    const unset = await ground();
    expect(unset).not.toBe(dark);
    // Unset is Inkstone, not the device's preference (wave-zero.md §10c).
    expect(unset).toBe('rgb(248, 244, 236)');
  });
});
