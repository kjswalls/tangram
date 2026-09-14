/**
 * The token layer in a real engine (docs/plans/core.md C0).
 *
 * `tests/unit/ui/tokens.test.ts` asserts the stylesheet's structure and its
 * hexes by reading the source, because jsdom resolves neither `var()` chains
 * nor `@media` for custom properties. This spec asserts what only a browser can
 * answer: what the cascade actually computes, in every theme state, under both
 * `prefers-color-scheme` emulations.
 *
 * **Five combinations, and the fifth is the point.** C0 rule 1 required the
 * unset case to be tested because it is the state every first-time visitor is
 * in and the four-combination spec never exercises it. It is asserted here with
 * the answer `wave-zero.md` §10c gives rather than the one core.md's own text
 * gives: **unset renders Inkstone on a dark-preferring device too**, because
 * §10c says the dark variant is optional and is not the default. If that ruling
 * is ever reversed, this is the test that has to change, and it will fail
 * loudly rather than drift.
 */
import { expect, test, type Page } from '@playwright/test';

/** product-decisions §11's settled hexes, as Chromium serialises them. */
const INKSTONE = {
  paper: 'rgb(248, 244, 236)',
  surface: 'rgb(255, 253, 249)',
  ink: 'rgb(28, 26, 23)',
  practice: 'rgb(185, 58, 38)',
  lookup: 'rgb(15, 118, 110)',
  new: 'rgb(138, 100, 20)',
};

/** Resolve a custom property through the cascade, as a colour. */
async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((property) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${property})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
}

async function bodyBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

async function setTheme(page: Page, value: string | null): Promise<void> {
  await page.evaluate((theme) => {
    if (theme === null) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, value);
}

test.describe('the theme layer', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(`under prefers-color-scheme: ${colorScheme}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme });
        await page.goto('/');
      });

      test('with data-theme unset, the app is Inkstone — the default, not the system', async ({
        page,
      }) => {
        expect(
          await page.evaluate(() => document.documentElement.dataset.theme ?? null),
        ).toBeNull();
        expect(await bodyBackground(page)).toBe(INKSTONE.paper);
        expect(await token(page, '--ink')).toBe(INKSTONE.ink);
        expect(await token(page, '--practice')).toBe(INKSTONE.practice);
      });

      test('toggling data-theme changes the ground in both directions', async ({ page }) => {
        await setTheme(page, 'light');
        const light = await bodyBackground(page);
        expect(light).toBe(INKSTONE.paper);

        await setTheme(page, 'dark');
        const dark = await bodyBackground(page);
        expect(dark).not.toBe(light);

        // and back — a one-way swap would pass a "they differ" assertion
        await setTheme(page, 'light');
        expect(await bodyBackground(page)).toBe(light);
      });

      test('data-theme=system is the only state that follows the device', async ({ page }) => {
        await setTheme(page, 'system');
        const followed = await bodyBackground(page);
        if (colorScheme === 'dark') expect(followed).not.toBe(INKSTONE.paper);
        else expect(followed).toBe(INKSTONE.paper);
      });
    });
  }

  test('every settled hex is what the light palette computes to', async ({ page }) => {
    await page.goto('/');
    expect(await token(page, '--paper')).toBe(INKSTONE.paper);
    expect(await token(page, '--surface')).toBe(INKSTONE.surface);
    expect(await token(page, '--ink')).toBe(INKSTONE.ink);
    expect(await token(page, '--practice')).toBe(INKSTONE.practice);
    expect(await token(page, '--lookup')).toBe(INKSTONE.lookup);
    expect(await token(page, '--new')).toBe(INKSTONE.new);
  });

  test('the radius scale reaches the cascade, and Tailwind\'s own is untouched', async ({
    page,
  }) => {
    await page.goto('/');
    const read = (names: string[]) =>
      page.evaluate((keys) => {
        const style = getComputedStyle(document.documentElement);
        return keys.map((name) => style.getPropertyValue(name).trim());
      }, names);

    expect(await read(['--r-sm', '--r-md', '--r-lg'])).toEqual(['12px', '16px', '24px']);
    // The app's scale is `--r-*` precisely so that it does NOT shadow
    // Tailwind's `--radius-*` namespace and silently reshape every
    // `rounded-md` in forty components. Assert the defaults survived.
    // Parsed as numbers, not compared as strings: the production minifier
    // writes Tailwind's own `0.25rem` as `.25rem`, so a literal comparison here
    // passes in dev and fails in the build the suite actually runs against.
    const asRem = (values: string[]) =>
      values.map((value) => {
        expect(value, 'a Tailwind radius default is missing').toMatch(/rem$/);
        return Number.parseFloat(value);
      });
    expect(asRem(await read(['--radius-sm', '--radius-md', '--radius-lg']))).toEqual([
      0.25, 0.375, 0.5,
    ]);
  });

  /**
   * A family declared only inside `@theme inline` and referenced only through
   * an arbitrary value can be pruned out of the stylesheet, leaving
   * `var(--font-display)` resolving to nothing — which no unit test sees,
   * because the pruning happens in the build. This is the assertion that does.
   */
  test('all three type families reach the cascade', async ({ page }) => {
    await page.goto('/');
    const families = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ['--font-display', '--font-ui', '--font-hanzi'].map((name) =>
        style.getPropertyValue(name).trim(),
      );
    });
    expect(families[0]).toContain('Newsreader');
    expect(families[1]).toContain('DM Sans');
    expect(families[2]).toContain('Noto Serif SC');
  });
});
