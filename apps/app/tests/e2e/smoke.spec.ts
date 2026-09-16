import { expect, test, type Page } from '@playwright/test';

import { installDictionary } from './dict';

/**
 * The app shell, rebuilt around three tabs (docs/plans/core.md C7).
 *
 * This spec was seven routes and their headings; it is three destinations and
 * the two sub-paths inside them. What it asserts is unchanged in kind — every
 * page renders, the bar marks where you are, the bar walks everywhere, the
 * dictionary gate covers the surfaces that need it and nothing else, the
 * licences render, and it all fits a 390px phone.
 */
const PAGES = [
  { path: '/', tab: 'lookup', heading: 'Look up' },
  { path: '/read', tab: 'lookup', heading: 'Your own texts' },
  { path: '/practice', tab: 'practice', heading: 'Practice' },
  { path: '/library', tab: 'library', heading: 'Library' },
] as const;

const TABS = [
  { key: 'lookup', label: 'Look up' },
  { key: 'practice', label: 'Practice' },
  { key: 'library', label: 'Library' },
] as const;

const bar = (page: Page) => page.getByTestId('tab-bar');

test.describe('app shell', () => {
  for (const entry of PAGES) {
    test(`${entry.path} renders its heading and the whole tab bar`, async ({ page }) => {
      await page.goto(entry.path);
      await expect(page.getByRole('heading', { level: 1, name: entry.heading })).toBeVisible();
      for (const tab of TABS) {
        await expect(bar(page).getByRole('link', { name: tab.label, exact: true })).toBeVisible();
      }
      // …and exactly one bar. The two shells are chosen, never both rendered:
      // two would mean two `aria-current`s and a screen reader reading the
      // hidden one.
      await expect(bar(page)).toHaveCount(1);
    });
  }

  test('a sub-path keeps its own tab marked', async ({ page }) => {
    // `/read` is inside Look up and `/library/lists/:id` inside Library. A tab
    // that unmarks itself as soon as a learner opens something is the failure
    // `tabForPath`'s longest-prefix rule exists to prevent.
    await page.goto('/read');
    await expect(bar(page).getByRole('link', { name: 'Look up', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('the bar marks the tab you are on, and only that one', async ({ page }) => {
    await page.goto('/library');
    await expect(bar(page).getByRole('link', { name: 'Library', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(
      bar(page).getByRole('link', { name: 'Look up', exact: true }),
    ).not.toHaveAttribute('aria-current', 'page');
  });

  test('the bar walks every tab', async ({ page }) => {
    await page.goto('/');
    for (const tab of TABS.slice(1)) {
      await bar(page).getByRole('link', { name: tab.label, exact: true }).click();
      const target = PAGES.find((entry) => entry.tab === tab.key)!;
      await expect(page).toHaveURL(new RegExp(`${target.path}$`));
      await expect(page.getByRole('heading', { level: 1, name: target.heading })).toBeVisible();
    }
  });

  test('the Look up tab renders the panel shell with its slot contract', async ({ page }) => {
    // The panel is inside `<DictGate>`, so this one needs a dictionary. The ask
    // is accepted here rather than through `tests/e2e/dict.ts`'s option,
    // because two tests in this file are *about* a fresh origin.
    await installDictionary(page);
    await page.goto('/');
    await expect(page.getByTestId('lookup-panel')).toBeVisible();
    await expect(page.getByTestId('lookup-body')).toBeVisible();
    // Nothing injects the slot, and with no query there is nothing to ask
    // about either: both ask regions are absent on a bare Look up tab.
    await expect(page.getByTestId('lookup-ask-slot')).toHaveCount(0);
    await expect(page.getByTestId('lookup-ask')).toHaveCount(0);
  });

  /**
   * `components/shell/data-banner.tsx` is **deleted** (core.md C4a, `data.md`
   * D4): a banner on every route, driven by a `HEAD` probe on every mount, is
   * replaced one-for-one by `<DictGate>` on the surfaces that actually need the
   * dictionary. The two cases move with it.
   *
   * Library is the learner's own data and is **not** gated — asserted below,
   * because "the app keeps working without a dictionary" is `data.md` D4's
   * requirement of this phase and the easiest thing to lose.
   */
  test('a dictionary that cannot answer gates Look up, and says what to do', async ({ page }) => {
    // Deterministic stand-in for a deploy that skipped `pnpm data` (PLAN.md
    // §3.2). Since `data.md` D6 the dictionary is a file the browser fetches,
    // not a route it calls, so the manifest is what refuses — which is exactly
    // what a missing `data/` directory looks like to a learner.
    await page.route('**/dict-manifest.json', (route) => route.fulfill({ status: 503, body: '' }));
    await page.goto('/');
    const gate = page.getByTestId('dict-gate');
    await expect(gate).toBeVisible();
    await expect(page.getByTestId('dict-status')).toBeVisible();
    // …and the search box is not offered, rather than offered and broken.
    await expect(page.getByTestId('lookup-input')).toHaveCount(0);

    // The first screen is the ask, because the gate's mount fetches nothing —
    // a manifest that refuses is not something a mount effect finds out. The
    // learner presses it and *then* is told what went wrong, with a retry.
    await expect(gate).toHaveAttribute('data-state', 'absent');
    await gate.getByTestId('dict-start').click();
    await expect(gate).toHaveAttribute('data-state', 'failed');
    await expect(gate.getByTestId('dict-retry')).toBeVisible();

    // The learner's own data is untouched.
    await page.goto('/library');
    await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
    await expect(page.getByTestId('dict-gate')).toHaveCount(0);
  });

  /**
   * **A learner who has the dictionary sees no gate**, which is the other half
   * of the two-phase open and the half a suite can lose without noticing.
   *
   * `installDictionary()` is the ask, accepted once — so this test earns its
   * origin rather than assuming one, and would fail both if the ask stopped
   * appearing and if accepting it stopped producing a working lookup box.
   * `tests/e2e/d/dict-ask.spec.ts` is where the byte counts behind it live.
   */
  test('no gate when the dictionary answers', async ({ page }) => {
    await installDictionary(page);
    await page.goto('/');
    await expect(page.getByTestId('lookup-input')).toBeVisible();
    await expect(page.getByTestId('dict-gate')).toHaveCount(0);
  });

  test('Library carries the licences section, rendered as prose', async ({ page }) => {
    await page.goto('/library');
    await expect(page.getByRole('heading', { name: 'Licenses' })).toBeVisible();
    // ATTRIBUTION.md is Markdown: it must not reach the page as raw `##` and `**`.
    await expect(page.getByRole('heading', { name: /CC-CEDICT/ })).toBeVisible();
    await expect(page.locator('main')).not.toContainText('## CC-CEDICT');
  });

  test('the tab bar fits a 390px phone, and is where a thumb is', async ({ page }) => {
    // Seven links used to total 381px in a 366px row and scroll silently, so
    // the last one read "Setting" with no affordance to reach the rest. Three
    // tabs have room; what has to be checked now is the other half of §1's
    // statement — that the bar is at the BOTTOM and clears the home indicator.
    const width = 390;
    const height = 844;
    await page.setViewportSize({ width, height });
    await page.goto('/');
    for (const tab of TABS) {
      const link = bar(page).getByRole('link', { name: tab.label, exact: true });
      const box = await link.boundingBox();
      if (!box) throw new Error(`${tab.label} has no box`);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      // A hand-sized target, not a text link.
      expect(box.height).toBeGreaterThanOrEqual(40);
      // Thumb reach: the bar is in the bottom quarter of the viewport.
      expect(box.y).toBeGreaterThan(height * 0.75);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('the fixed bar does not sit on top of the screen’s last control', async ({ page }) => {
    // A bar fixed over a scrolling column hides whatever the column ends with.
    // On this app that is the grade dock, which is the one control a learner
    // cannot do without — so the column reserves the bar's height.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/library');
    const barBox = await bar(page).boundingBox();
    const mainBottom = await page.evaluate(() => {
      const main = document.querySelector('main')!;
      const style = getComputedStyle(main);
      return Number.parseFloat(style.paddingBottom);
    });
    expect(barBox).not.toBeNull();
    expect(mainBottom).toBeGreaterThanOrEqual(barBox!.height - 8);
  });

  test('the tab icon exists, so no route 404s on a favicon', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('link[rel~="icon"]')).toHaveCount(1);
    expect((await page.request.get('/icon.svg')).status()).toBe(200);
  });
});
