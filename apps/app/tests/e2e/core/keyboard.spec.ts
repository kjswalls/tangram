/**
 * The keyboard model, driven with a keyboard (docs/plans/web.md W8,
 * criterion 4).
 *
 * **Nothing in this file uses a pointer.** No click, no tap, no hover, no
 * `mouse.*`, and no `locator.press()` either — `press()` focuses the element
 * for you, which is exactly the part a keyboard-only test is supposed to prove.
 * Focus is moved with Tab and Shift+Tab, from wherever the browser put it after
 * a load, and every assertion about where focus *is* reads
 * `document.activeElement` rather than trusting the last thing that was
 * targeted. `tests/unit/keys/keyboard-spec.test.ts` greps this file and fails
 * if a pointer call appears in it, because "keyboard only" is a claim that
 * decays the moment somebody adds one convenient click.
 *
 * The one exception is the fixture: `dictionary: 'installed'` presses **Get
 * it** before the body runs, because without a dictionary there is no lookup
 * box to put focus in. That is setup, not the test.
 *
 * ## The case this file exists for
 *
 * W8's rule 1 — *a binding without a modifier never fires while focus is in a
 * text input* — is the one that ships broken in real products, because it holds
 * only for as long as every handler remembers to check. Two cases below would
 * fail against a registry without scopes, and they are written so that the
 * failure is the character that did not arrive rather than something vague
 * about focus:
 *
 * - typing `/` into the lookup box leaves a `/` in the box (a registry without
 *   scopes would swallow it and re-focus the box instead), and
 * - typing `?` into it leaves a `?` and no dialog (a registry without scopes
 *   would open the shortcuts sheet over the word being typed).
 */
import { expect, test, type Page } from '../dict';

import { DASUAN, KANKAN, seed } from '../p2/fixtures';
import { ready } from '../p3/helpers';

test.use({ dictionary: 'installed' });

/** What has focus, as a string a failure message can be read off. */
async function focus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return 'body';
    const bits = [el.tagName.toLowerCase()];
    if (el.id) bits.push(`#${el.id}`);
    if (el.dataset.testid) bits.push(`@${el.dataset.testid}`);
    if (el.dataset.tab) bits.push(`tab=${el.dataset.tab}`);
    if (el.hasAttribute('data-route-heading')) bits.push(`h1=${el.textContent?.trim() ?? ''}`);
    return bits.join(' ');
  });
}

/**
 * Press Tab (or Shift+Tab) until focus matches, or fail saying where it got to.
 *
 * The bound is generous but finite: an unbounded walk around a focus trap is a
 * test that hangs rather than fails, and the two are not the same report.
 */
async function tabUntil(
  page: Page,
  matches: (where: string) => boolean,
  options: { back?: boolean; max?: number } = {},
): Promise<void> {
  const key = options.back ? 'Shift+Tab' : 'Tab';
  const seen: string[] = [];
  for (let step = 0; step < (options.max ?? 40); step += 1) {
    await page.keyboard.press(key);
    const where = await focus(page);
    seen.push(where);
    if (matches(where)) return;
  }
  throw new Error(`${key} never reached the target. Visited: ${seen.join(' → ')}`);
}

const onTab = (key: string) => (where: string) => where.includes(`tab=${key}`);

/**
 * Wait for the lookup box to be in the document before walking the tab order
 * to it.
 *
 * It lives inside `<DictGate>`, which opens the stored dictionary in an effect:
 * for the first moment of a page load the box is not in the DOM at all, so a
 * tab walk started immediately goes straight past the place it will appear and
 * never comes back. Not a pointer — a wait.
 */
async function lookupBoxReady(page: Page): Promise<void> {
  await expect(page.getByTestId('lookup-input')).toBeVisible();
}

test.describe('every tab and every primary action, with no pointer', () => {
  test('Tab and Enter reach all three tabs', async ({ page }) => {
    await page.goto('/');
    await ready(page);

    await tabUntil(page, onTab('practice'));
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-route="/practice"]')).toHaveCount(1);
    // Criterion 2, from the keyboard side: the navigation put focus on the new
    // view's heading rather than leaving it on the tab that was pressed.
    await expect.poll(() => focus(page)).toContain('h1=Practice');
    await expect(page.getByTestId('route-announcer')).toHaveText('Practice');

    // Back up the tab order to reach the tabs again — they are before `<main>`
    // in the document, and the heading focus just put us after them.
    await tabUntil(page, onTab('library'), { back: true });
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-route="/library"]')).toHaveCount(1);
    await expect.poll(() => focus(page)).toContain('h1=Library');

    await tabUntil(page, onTab('lookup'), { back: true });
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-route="/"]')).toHaveCount(1);
    await expect.poll(() => focus(page)).toContain('h1=Look up');
  });

  test('Tab reaches the lookup box, and what is typed there reaches the URL', async ({ page }) => {
    await page.goto('/');
    await ready(page);

    await lookupBoxReady(page);
    await tabUntil(page, (where) => where.includes('#lookup-query'));
    await page.keyboard.type('打算');
    await expect(page.getByTestId('lookup-input')).toHaveValue('打算');
    // The URL is the shared state (W8), so what was typed is now linkable.
    await expect(page).toHaveURL(/\?q=%E6%89%93%E7%AE%97/);
  });

  test('…and the Look up tab’s other primary action', async ({ page }) => {
    // Deliberately a second test with an empty box: a search puts up to fifty
    // result buttons between the box and this one, and a tab walk past them is
    // a walk this file would have to bound at an arbitrary number.
    await page.goto('/');
    await ready(page);

    await tabUntil(page, (where) => where.includes('@open-texts'));
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-route="/read"]')).toHaveCount(1);
  });

  test('the practice session is a keyboard session: Space reveals, 1–4 grade', async ({ page }) => {
    await page.goto('/read');
    await ready(page);
    await page.evaluate(async () => {
      await window.__tangram.repo.resetAll();
      await window.__tangram.repo.setSettings({ newPerDay: 0 });
    });
    await seed(page, [
      { entry: DASUAN, gradedDaysAgo: 30 },
      { entry: KANKAN, gradedDaysAgo: 31 },
    ]);
    await page.goto('/practice');
    await ready(page);
    await expect(page.getByTestId('review-session')).toBeVisible({ timeout: 30_000 });

    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toBeVisible();
    await page.keyboard.press('3');
    // The second card arrives, front side up, with no pointer involved.
    await expect(page.getByTestId('card-back')).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('card-back')).toBeVisible();
    await page.keyboard.press('4');
    await expect(page.getByTestId('review-session')).toBeVisible();
  });
});

test.describe('W8 rule 1 — an unmodified binding never fires while typing', () => {
  test('/ types a slash into the lookup box instead of jumping to it', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    await lookupBoxReady(page);
    await tabUntil(page, (where) => where.includes('#lookup-query'));

    await page.keyboard.type('好/');
    // Against a registry with no scope model, `lookup.focus` would have fired,
    // called preventDefault, and selected the box's contents: the value would
    // be `好` and the selection would be the whole of it.
    await expect(page.getByTestId('lookup-input')).toHaveValue('好/');
    await expect.poll(() => focus(page)).toContain('#lookup-query');
  });

  test('? types a question mark instead of opening the shortcuts sheet', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    await lookupBoxReady(page);
    await tabUntil(page, (where) => where.includes('#lookup-query'));

    await page.keyboard.type('what?');
    await expect(page.getByTestId('lookup-input')).toHaveValue('what?');
    await expect(page.getByTestId('shortcut-help')).toHaveCount(0);
  });

  test('…and 1–4 do not grade a card while the recall box has focus', async ({ page }) => {
    await page.goto('/read');
    await ready(page);
    await page.evaluate(async () => {
      await window.__tangram.repo.resetAll();
      await window.__tangram.repo.setSettings({ newPerDay: 0, freeRecall: true });
    });
    await seed(page, [{ entry: DASUAN, gradedDaysAgo: 30 }]);
    await page.goto('/practice');
    await ready(page);
    await expect(page.getByTestId('review-session')).toBeVisible({ timeout: 30_000 });

    await tabUntil(page, (where) => where.includes('@recall-answer'));
    await page.keyboard.type('1234');
    await expect(page.getByTestId('recall-answer')).toHaveValue('1234');
    // Still the same card, still face down: nothing was graded.
    await expect(page.getByTestId('card-back')).toBeHidden();
  });
});

test.describe('the modified bindings, which do fire while typing', () => {
  test('Mod+K reaches the lookup box from another tab and selects what is in it', async ({
    page,
  }) => {
    await page.goto('/');
    await ready(page);
    await lookupBoxReady(page);
    await tabUntil(page, (where) => where.includes('#lookup-query'));
    await page.keyboard.type('打算');
    await expect(page.getByTestId('lookup-input')).toHaveValue('打算');

    await tabUntil(page, onTab('practice'), { back: true });
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-route="/practice"]')).toHaveCount(1);

    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('[data-route="/"]')).toHaveCount(1);
    await expect.poll(() => focus(page)).toContain('#lookup-query');
    // Selected, not appended: "jump to the lookup box" means start a search.
    expect(
      await page.evaluate(() => {
        const box = document.getElementById('lookup-query') as HTMLInputElement | null;
        return box === null ? null : [box.selectionStart, box.selectionEnd, box.value.length];
      }),
    ).toEqual([0, 2, 2]);
  });

  test('? opens the generated sheet, and Escape always leaves it', async ({ page }) => {
    await page.goto('/practice');
    await ready(page);

    await page.keyboard.press('?');
    const sheet = page.getByTestId('shortcut-help');
    await expect(sheet).toBeVisible();
    // Generated from the registry: the practice session's keys are in it even
    // though nothing on this page wrote them down.
    await expect(sheet).toContainText('Show the answer');
    await expect(sheet).toContainText('Jump to the lookup box');
    await expect(sheet.locator('[data-shortcut]')).toHaveCount(7);

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });
});

test.describe('an IME composition is not a shortcut', () => {
  /**
   * A learner spelling 出租车 through a pinyin IME produces a `keydown` per
   * Latin letter, each one a shortcut candidate. Playwright cannot drive a real
   * IME, and CDP's `Input.imeSetComposition` sends composition events without
   * the keydowns that carry the flag — so the event is dispatched directly.
   * That is an honest test of the guard: the listener is the thing under test,
   * and the control case below proves the dispatch itself works.
   */
  const composing = (page: Page, isComposing: boolean) =>
    page.evaluate((flag) => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '?',
          bubbles: true,
          cancelable: true,
          isComposing: flag,
        }),
      );
    }, isComposing);

  test('a keydown with isComposing set fires nothing', async ({ page }) => {
    await page.goto('/practice');
    await ready(page);

    await composing(page, true);
    await expect(page.getByTestId('shortcut-help')).toHaveCount(0);

    // The control: the same event without the flag does open the sheet, so the
    // case above is not passing because nothing was delivered.
    await composing(page, false);
    await expect(page.getByTestId('shortcut-help')).toBeVisible();
  });
});
