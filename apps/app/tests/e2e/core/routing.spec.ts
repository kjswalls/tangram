/**
 * The URL model, focus and scroll on navigation (docs/plans/web.md W8,
 * criteria 2 and 3).
 *
 * The keyboard half is `keyboard.spec.ts`, which may not use a pointer. This
 * one may, because what it is about is the router: what a route change does to
 * focus and to the announcer, what Back does to a search, and whether a scrolled
 * list comes back scrolled.
 *
 * **Criterion 3 is the one with a real trap in it.** Scroll restoration and
 * focus management fight: `<ScrollRestoration>` puts the offset back in a
 * layout effect, and the announcer then focuses the new view's heading — which,
 * with a default `focus()`, scrolls it into view and undoes the restore. The
 * announcer passes `preventScroll`. The case below is what fails if it stops.
 */
import { expect, test, type Page } from '../dict';

import { ready } from '../p3/helpers';

test.use({ dictionary: 'installed' });

const announcer = (page: Page) => page.getByTestId('route-announcer');
const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));

test.describe('a route change moves focus and says where you are', () => {
  test('focus lands on the new heading and the live region names the route', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    // Nothing is announced on the first load: the browser has already put the
    // learner at the top of a freshly rendered document.
    await expect(announcer(page)).toHaveText('');

    await page.getByTestId('tab-link').filter({ hasText: 'Practice' }).click();
    await expect(page.locator('[data-route="/practice"]')).toHaveCount(1);
    await expect(announcer(page)).toHaveText('Practice');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return el?.hasAttribute('data-route-heading') === true ? el.textContent?.trim() : null;
        }),
      )
      .toBe('Practice');

    await page.getByTestId('tab-link').filter({ hasText: 'Library' }).click();
    await expect(announcer(page)).toHaveText('Library');
  });

  test('a live region a screen reader is already watching', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    const region = announcer(page);
    await expect(region).toHaveAttribute('aria-live', 'polite');
    await expect(region).toHaveAttribute('role', 'status');
  });
});

test.describe('scroll position survives a back-navigation', () => {
  test('a scrolled list comes back scrolled', async ({ page }) => {
    await page.goto('/library');
    await ready(page);
    // Library is tall without waiting for anything: the attribution notice is a
    // build-time import and is rendered in full (a licence obligation, CLAUDE.md).
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight))
      .toBeGreaterThan(600);

    await page.evaluate(() => window.scrollTo(0, 600));
    await expect.poll(() => scrollY(page)).toBe(600);

    await page.getByTestId('tab-link').filter({ hasText: 'Practice' }).click();
    await expect(page.locator('[data-route="/practice"]')).toHaveCount(1);
    await expect.poll(() => scrollY(page)).toBe(0);

    await page.goBack();
    await expect(page.locator('[data-route="/library"]')).toHaveCount(1);
    // The restore is a layout effect; the focus move that follows it must not
    // scroll. A tolerance of a few pixels, because the offset is restored
    // against a page the browser has only just laid out again.
    await expect.poll(() => scrollY(page)).toBeGreaterThan(560);
  });
});

test.describe('?q= is the lookup', () => {
  test('a shared link opens on the word', async ({ page }) => {
    await page.goto('/?q=%E6%89%93%E7%AE%97');
    await ready(page);
    // The box is inside `<DictGate>` and arrives an effect late, so this waits
    // for it rather than assuming a cold load has one.
    await expect(page.getByTestId('lookup-input')).toBeVisible();
    await expect(page.getByTestId('lookup-input')).toHaveValue('打算');
    await expect(page.getByTestId('lookup-panel')).toContainText('打算');
  });

  test('Back undoes a search rather than leaving the app', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    await page.getByTestId('lookup-input').fill('dasuan');
    await expect(page).toHaveURL(/\?q=dasuan/);

    // Refining it replaces rather than pushes, so Back is not a per-keystroke
    // undo: one press returns to the empty page, not to `dasua`.
    await page.getByTestId('lookup-input').fill('dasuan4');
    await expect(page).toHaveURL(/\?q=dasuan4/);

    await page.goBack();
    await expect(page).not.toHaveURL(/\?q=/);
    await expect(page.getByTestId('lookup-input')).toHaveValue('');
  });

  test('a tab change drops the query from the URL and brings it back with the tab', async ({
    page,
  }) => {
    await page.goto('/');
    await ready(page);
    await page.getByTestId('lookup-input').fill('dasuan');
    await expect(page).toHaveURL(/\?q=dasuan/);

    await page.getByTestId('tab-link').filter({ hasText: 'Practice' }).click();
    await expect(page).toHaveURL(/\/practice$/);

    // Coming back restores the box — it always did, the store is a module
    // singleton — and now the URL says so too, which is what makes the state
    // shared rather than hidden.
    await page.getByTestId('tab-link').filter({ hasText: 'Look up' }).click();
    await expect(page.getByTestId('lookup-input')).toHaveValue('dasuan');
    await expect(page).toHaveURL(/\?q=dasuan/);
  });

  test('a search does not scroll the page to the top while you type', async ({ page }) => {
    // `<ScrollRestoration>` scrolls to 0 on every navigation that is not a POP
    // with a saved position, and a settled keystroke is a navigation. Without
    // `preventScrollReset` the page jumps on every word.
    await page.goto('/?q=the');
    await ready(page);
    await expect(page.getByTestId('lookup-input')).toHaveValue('the');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight))
      .toBeGreaterThan(300);
    await page.evaluate(() => window.scrollTo(0, 300));
    await expect.poll(() => scrollY(page)).toBe(300);

    await page.getByTestId('lookup-input').fill('theatre');
    await expect(page).toHaveURL(/\?q=theatre/);
    expect(await scrollY(page)).toBeGreaterThan(0);
  });
});
