/**
 * The two shells, and the rule that the screens are identical
 * (docs/plans/core.md C7).
 *
 * **The enforcement is the deliverable, not the two shells.** The static half —
 * that no screen imports the router or the shell — is
 * `tests/unit/shell/screens-are-portable.test.ts`, because there is no CI and a
 * rule that wants enforcement is a unit test or it is nothing. This is the
 * dynamic half, and it is the one C7 words carefully: "the spec asserts
 * **equality of the extracted text content** between the two widths, not just
 * that both render."
 *
 * That distinction is the whole value of the file. A spec that renders each
 * screen at both widths and checks the ids are present passes against two
 * different designs; comparing the text is what fails the day one shell starts
 * showing something the other does not.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { DASUAN, openReview, seed } from '../p2/fixtures';

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

/**
 * The readings-stripped text of a region, read **once it has stopped moving**.
 *
 * Every region this spec compares finishes asynchronously — the card back's
 * example sentences arrive from the ask layer, the library's band counts fill
 * in as the spine materialises. Reading each width at "the first moment the
 * region is visible" compares two different instants, and the diff that comes
 * back is a race, not a shell difference: the run that made this helper failed
 * with `no words yet` against `752 words · 752 known` for the same row.
 *
 * So both reads wait for the same *settled* state: the text has to come back
 * identical twice in a row before it counts. That is the only honest way to
 * compare two renders of an asynchronous screen, and it keeps the assertion
 * below meaning what C7 says it means.
 */
/**
 * The text a learner can actually **see**, with the ruby readings dropped.
 *
 * Deliberately not `baseText`, and that is the point of the whole file.
 * `baseText` clones the node and reads `textContent`, which includes every
 * element hidden by a responsive utility class — so a `hidden wide:inline` span
 * reads identically at 390px and 1280px and the equality assertions below
 * survive the exact drift they exist to catch. The pattern is already live in
 * the compared subtree (`lookup-view.tsx` hides a whole panel column with
 * `hidden md:block`), so this is not a hypothetical.
 *
 * Computed styles cannot be read off a detached clone, so this walks the live
 * DOM instead and skips what the browser is not painting — plus `<rt>`/`<rp>`,
 * which is what `baseText` was for.
 */
async function visibleBaseText(scope: Locator): Promise<string> {
  return scope.evaluate((root) => {
    const skip = new Set(['RT', 'RP', 'SCRIPT', 'STYLE', 'TEMPLATE']);
    const read = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const element = node as HTMLElement;
      if (skip.has(element.tagName)) return '';
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
      let out = '';
      for (const child of element.childNodes) out += read(child);
      return out;
    };
    return read(root).replace(/\s+/g, ' ').trim();
  });
}

async function settled(scope: Locator): Promise<string> {
  const read = () => visibleBaseText(scope);
  // Three equal reads, not two. The library's band fill lands in batches with
  // gaps between them, and a single quiet interval is exactly what a batch
  // boundary looks like.
  let previous = await read();
  let stable = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await scope.page().waitForTimeout(250);
    const current = await read();
    stable = current !== '' && current === previous ? stable + 1 : 0;
    previous = current;
    if (stable >= 2) return current;
  }
  throw new Error(`text of ${scope} never settled`);
}

/** The settled, readings-stripped text of a test id. */
function textOf(page: Page, testId: string): Promise<string> {
  return settled(page.getByTestId(testId));
}

/** Which shell is in the DOM, and there must be exactly one. */
async function shell(page: Page): Promise<string> {
  const phone = await page.getByTestId('phone-shell').count();
  const wide = await page.getByTestId('wide-shell').count();
  expect(phone + wide, 'exactly one shell, always').toBe(1);
  return phone === 1 ? 'phone' : 'wide';
}

test.describe('the two shells', () => {
  test('are chosen, never both rendered', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/');
    expect(await shell(page)).toBe('phone');

    await page.setViewportSize(DESKTOP);
    // The choice follows a live media query, so a resize switches it without a
    // reload — which is what a desktop browser window being dragged does.
    await expect(page.getByTestId('wide-shell')).toBeVisible();
    expect(await shell(page)).toBe('wide');

    await page.setViewportSize(PHONE);
    await expect(page.getByTestId('phone-shell')).toBeVisible();
    expect(await shell(page)).toBe('phone');
  });

  test('the same lookup result reads identically at 390px and 1280px', async ({ page }) => {
    const read = async (size: { width: number; height: number }) => {
      await page.setViewportSize(size);
      await page.goto('/');
      await page.getByTestId('lookup-input').fill('打算');
      const first = page.getByTestId('search-result').first();
      await expect(first).toBeVisible({ timeout: 20_000 });
      await first.click();
      await expect(page.getByTestId('entry-detail')).toBeVisible();
      return textOf(page, 'entry-detail');
    };

    const phone = await read(PHONE);
    const wide = await read(DESKTOP);
    expect(phone.length).toBeGreaterThan(20);
    expect(wide).toBe(phone);
  });

  test('the same practice card reads identically at 390px and 1280px', async ({ page }) => {
    const read = async (size: { width: number; height: number }) => {
      await page.setViewportSize(size);
      await openReview(page);
      // The back's example sentences are an asynchronous, ask-layer-backed
      // region; `settled` would wait them out, but switching them off keeps
      // the comparison about the card rather than about the offline fallback
      // text the ask layer happens to render without a key.
      await page.evaluate(async () => {
        await window.__tangram.repo.setSettings({ examplesOnBack: false });
      });
      await seed(page, [{ entry: DASUAN, gradedDaysAgo: 30 }]);
      await expect(page.getByTestId('reveal')).toBeVisible();
      await page.keyboard.press('Space');
      await expect(page.getByTestId('card-back')).toBeVisible();
      return textOf(page, 'review-session');
    };

    const phone = await read(PHONE);
    const wide = await read(DESKTOP);
    expect(phone.length).toBeGreaterThan(20);
    expect(wide).toBe(phone);
  });

  test('the same library row reads identically at 390px and 1280px', async ({ page }) => {
    const read = async (size: { width: number; height: number }) => {
      await page.setViewportSize(size);
      await page.goto('/library');
      // One row, not the whole `lists` container: the bands materialise one
      // after another, so "every row" is a moving target for far longer than
      // "this row".
      const row = page.locator('[data-list-name="HSK 1"]');
      await expect(row.getByTestId('list-count')).toBeVisible({ timeout: 180_000 });
      return settled(row);
    };

    const phone = await read(PHONE);
    const wide = await read(DESKTOP);
    expect(phone.length).toBeGreaterThan(20);
    expect(wide).toBe(phone);
  });

  test('crossing the breakpoint keeps the screen, its state and its focus', async ({ page }) => {
    /**
     * A phone rotated to landscape crosses 45rem, and so does a desktop window
     * being dragged. The first build chose between two *component types*, so
     * every crossing destroyed and rebuilt the screen subtree: a half-typed
     * answer was gone, focus was on `<body>`, and on the Practice tab
     * `ReviewSession`'s unmount cleanup (`reset()`) threw the session's
     * progress away. One component with a `wide` flag is what fixes it, and
     * this is the assertion that says so.
     */
    await page.setViewportSize(PHONE);
    await page.goto('/');
    const input = page.getByTestId('lookup-input');
    await input.click();
    await input.fill('打算');
    await expect(page.getByTestId('search-result').first()).toBeVisible({ timeout: 20_000 });

    await page.setViewportSize(DESKTOP);
    await expect(page.getByTestId('wide-shell')).toBeVisible();

    // The same box, still holding what was typed, still focused.
    await expect(input).toHaveValue('打算');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
      'lookup-input',
    );
    await expect(page.getByTestId('search-result').first()).toBeVisible();
  });

  test('tab state survives navigating away and back', async ({ page }) => {
    // The reader's text is the state that has to survive: it lives in the store
    // rather than in the component, which is what makes a trip to Practice and
    // back return to where the learner was (PLAN.md §3.5).
    await page.setViewportSize(PHONE);
    await page.goto('/read');
    await page.getByTestId('reader-input').fill('我打算明天去北京。');
    await page.getByTestId('read-text').click();
    await expect(page.getByTestId('reader-text')).toBeVisible();

    const bar = page.getByTestId('tab-bar');
    await bar.getByRole('link', { name: 'Practice', exact: true }).click();
    await expect(page).toHaveURL(/\/practice$/);
    await bar.getByRole('link', { name: 'Look up', exact: true }).click();
    await page.getByTestId('open-texts').click();

    await expect(page.getByTestId('reader-text')).toBeVisible();
    await expect(page.getByTestId('reader-text')).toHaveAttribute(
      'data-hanzi',
      '我打算明天去北京。',
    );
  });

  test('the phone shell never puts the tab bar over the grade buttons', async ({ page }) => {
    /**
     * The tab bar is `fixed bottom-0`; the practice screen's grade dock is
     * `sticky bottom-0`. Before `--tab-bar-height` the dock pinned to the
     * bottom of the *viewport*, under the bar, and a tap on the centre of "Got
     * it" at 390px hit the Look up tab link and left the session. So this
     * asserts the thing a learner does: that the point they press belongs to
     * the button they pressed.
     */
    // **A short viewport on purpose.** The dock is `sticky`, so on a page that
    // fits it sits in normal flow above `main`'s bottom padding and the overlap
    // cannot happen — a test on a tall viewport passes without touching the
    // bug. 500px guarantees the card back overflows and the dock is pinned.
    await page.setViewportSize({ width: 390, height: 500 });
    await openReview(page);
    await seed(page, [{ entry: DASUAN, gradedDaysAgo: 30 }]);
    await expect(page.getByTestId('reveal')).toBeVisible();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('grade-bar')).toBeVisible();
    // The dock is genuinely pinned: the document is taller than the viewport.
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(500);

    const bar = (await page.getByTestId('tab-bar').boundingBox())!;
    for (const rating of [1, 2, 3, 4]) {
      const button = page.getByTestId(`grade-${rating}`);
      const box = (await button.boundingBox())!;
      // Wholly above the bar, with nothing of it underneath.
      expect(box.y + box.height, `grade-${rating} runs under the tab bar`).toBeLessThanOrEqual(
        bar.y + 1,
      );
      // …and the browser agrees about who owns the pixel.
      const owner = await page.evaluate(
        ({ x, y }) => {
          const element = document.elementFromPoint(x, y);
          return element?.closest('[data-testid]')?.getAttribute('data-testid') ?? null;
        },
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      );
      expect(owner, `something else owns the centre of grade-${rating}`).toBe(`grade-${rating}`);
    }
  });

  test('the tab-bar height token is the tab bar’s height, measured', async ({ page }) => {
    /**
     * `--tab-bar-height` is arithmetic done by hand in `tokens.css` over
     * classes that live in `ui/tab-bar.tsx`, and nothing made the two agree:
     * the first version summed the item's `min-h-11` and the list's `py-1` and
     * forgot the bar's own `border-t`, so the token was a pixel short. A pixel
     * does not show — the next change to the bar would be a whole row and would
     * be exactly as quiet. This is the only check that can see it: resolve the
     * token in the browser and compare it with what the bar actually occupies.
     * Found by C8's adversarial review.
     */
    await page.setViewportSize(PHONE);
    await page.goto('/');
    await expect(page.getByTestId('phone-shell')).toBeVisible();

    const measured = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="tab-bar"]') as HTMLElement;
      // A probe rather than `getPropertyValue`, which hands back the unresolved
      // `calc(...)` text: the browser computes `env()` and the rem scale.
      const probe = document.createElement('div');
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.height = 'var(--tab-bar-height)';
      document.body.append(probe);
      const token = probe.getBoundingClientRect().height;
      probe.remove();
      return { token, bar: bar.getBoundingClientRect().height };
    });

    // Sub-pixel layout rounding only: half a pixel, not a row.
    expect(Math.abs(measured.token - measured.bar)).toBeLessThanOrEqual(0.5);
  });

  test('the wide shell puts the tabs in the header, not under the thumb', async ({ page }) => {
    // The one difference between the shells, asserted so "close to free" stays
    // true rather than becoming a second design.
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    const box = (await page.getByTestId('tab-bar').boundingBox())!;
    expect(box.y).toBeLessThan(120);

    await page.setViewportSize(PHONE);
    await expect(page.getByTestId('phone-shell')).toBeVisible();
    const phoneBox = (await page.getByTestId('tab-bar').boundingBox())!;
    expect(phoneBox.y).toBeGreaterThan(844 * 0.75);
  });
});
