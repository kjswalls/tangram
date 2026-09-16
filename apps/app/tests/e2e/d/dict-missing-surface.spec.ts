/**
 * One error surface for the missing dictionary, on all three tabs
 * (docs/plans/web.md W6, part 2).
 *
 * **This is the durable half of that fix, and it is why the defect survived
 * everything else.** 1,941 unit tests and 282 e2e specs passed with the app
 * saying "the dictionary is not on this device yet" three different ways on
 * three tabs — a red line inside the Today card on Look up (directly beneath the
 * card that already explained it in better words), a red line under the empty
 * state on Practice, and on Library a bare lowercase fragment floating between
 * the New list card and the lists with no sentence around it and nothing to
 * press. Every one of those suites asserts **presence**: that a thing is on
 * screen, that a count is right, that a button works. None of them could ask
 * whether the app said the same thing twice, or said it in a shape a person
 * would read.
 *
 * So these cases assert three properties that are about *sense*:
 *
 *   1. each tab renders the dictionary's surface **at most once**;
 *   2. no tab renders the raw `Error.message` at all; and
 *   3. any tab that says the dictionary is missing also offers the button that
 *      fetches it — nobody is told about a problem and left with no way out.
 *
 * The default fixture in `tests/e2e/dict.ts` is a fresh origin with no
 * dictionary, which is exactly the state this is about, so nothing here opts
 * in to an install.
 */
import { expect, test } from '../dict';

/** The string `openDictStore()` rejects with. It must reach no screen. */
const RAW = 'the dictionary is not on this device yet';

const TABS = [
  { name: 'Look up', path: '/', screen: 'screen-lookup' },
  { name: 'Practice', path: '/practice', screen: 'screen-practice' },
  { name: 'Library', path: '/library', screen: 'screen-library' },
] as const;

test.describe('the missing dictionary is one surface, once, on every tab', () => {
  for (const tab of TABS) {
    test(`${tab.name} states it once and offers the way out`, async ({ page }) => {
      await page.goto(tab.path);
      await expect(page.getByTestId(tab.screen)).toBeVisible();
      // The gate and the notice are the same card in two mountings; the point is
      // that a tab shows one of them, not both and not two of either.
      const surfaces = page.getByTestId('dict-status');
      await expect(surfaces).toHaveCount(1);

      const surface = surfaces.first();
      await expect(surface).toContainText('dictionary');
      // The size, and the button. A learner told the dictionary is missing and
      // given nothing to press is the failure mode this asserts against.
      await expect(surface).toContainText('MB');
      await expect(surface.getByTestId('dict-start')).toBeVisible();
    });

    test(`${tab.name} never shows the raw error message`, async ({ page }) => {
      await page.goto(tab.path);
      await expect(page.getByTestId(tab.screen)).toBeVisible();
      // Give every async surface on the tab time to fail and render.
      await expect(page.getByTestId('dict-status')).toBeVisible();
      await page.waitForLoadState('networkidle');

      const body = (await page.locator('body').innerText()).toLowerCase();
      expect(body, `${tab.name} is showing the raw Error.message`).not.toContain(RAW);
      expect(body, `${tab.name} is composing the raw Error.message into a sentence`).not.toContain(
        'could not be drawn',
      );
    });
  }

  /**
   * The specific duplicate W6 part 2 names: on Look up the red line sat directly
   * beneath the card that already said it, in better words. The card wins.
   */
  test('Look up shows the card and no second sentence beneath it', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('dict-gate')).toHaveAttribute('data-state', 'absent');
    await expect(page.getByTestId('dict-status')).toHaveCount(1);
    await expect(page.getByTestId('today-error')).toHaveCount(0);
    await expect(page.getByTestId('today-draw-error')).toHaveCount(0);
  });

  /**
   * On Library it was an orphan: a lowercase fragment on the page ground,
   * between two cards, in no container. Whatever the surface is, it is inside
   * one — `<Card>` is a `<section>` with the app's border and radius.
   */
  test('Library states it inside a card, not loose between two', async ({ page }) => {
    await page.goto('/library');
    const surface = page.getByTestId('dict-status');
    await expect(surface).toHaveCount(1);
    const tag = await surface.evaluate((el) => el.tagName.toLowerCase());
    expect(tag).toBe('section');
    const border = await surface.evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(border).not.toBe('0px');
  });

  /**
   * A list's own page is below Library and has **two** things that fail on a
   * missing dictionary, at different moments: reading the list's entries, on
   * mount, and searching for a word to add, when the learner presses Find. Both
   * used to print the raw fragment; hanging the card off either one alone gives
   * a page that says nothing or says it twice.
   */
  test('a list page says it once, before and after a search', async ({ page }) => {
    await page.goto('/library');
    await expect(page.getByTestId('lists')).toBeVisible();
    // "Looked up" is the first list and is not an HSK band, so it carries the
    // Add-a-word box that the second failure comes from.
    await page.getByTestId('lists').getByRole('link', { name: 'Open' }).first().click();
    // `/library/lists/:id` since C7 — `/lists` is a removed route and
    // `tests/unit/shell/tab-routes.test.ts` polices any spec that names it.
    await expect(page).toHaveURL(/\/library\/lists\//);
    await expect(page.getByTestId('dict-status')).toHaveCount(1);

    const search = page.getByLabel('Find a word');
    await expect(search).toBeVisible();
    await search.fill('\u8dd1\u6b65');
    await page.getByRole('button', { name: 'Find' }).click();

    await expect(page.getByTestId('dict-status')).toHaveCount(1);
    const body = (await page.locator('body').innerText()).toLowerCase();
    expect(body).not.toContain(RAW);
  });

  /**
   * And the rule that must survive the fix: the app keeps working without a
   * dictionary (`data.md` D4, C4a). Practice and Library are the learner's own
   * data and are **not** gated — the notice sits beside their content, never in
   * front of it.
   */
  test('Practice and Library still render their own content', async ({ page }) => {
    await page.goto('/practice');
    await expect(page.getByTestId('review-empty')).toBeVisible();

    await page.goto('/library');
    await expect(page.getByTestId('lists')).toBeVisible();
    // Stats is the third thing on Library that reads the database and not the
    // dictionary. Its first card is the name to match, and the match is loose
    // because `<Card title>` is uppercased in CSS and Chromium folds
    // `text-transform` into the accessible name.
    await expect(page.getByRole('heading', { name: /how well it.s sticking/i })).toBeVisible();
  });
});
