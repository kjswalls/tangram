/**
 * The wide shell keeps its tabs in reach, and keeps focus out from under them
 * (the wide-shell phase; `HANDOFF.md`, W8a's "Recorded, not fixed").
 *
 * At 1280px — Playwright's desktop default, and the width this whole file runs
 * at. The phone arrangement is not tested here because it did not change: its
 * tabs are a `fixed` bar at the bottom, and every 390px spec is untouched.
 *
 * **Everything below is geometry, not screenshots.** A pinned header moves the
 * top edge of the usable viewport down by its own height, and the failure it
 * invites is a focused control sitting *under* it — on screen by any
 * `toBeVisible()` measure, and invisible to the learner. So each case reads
 * bounding rectangles and asks what is actually at a point.
 *
 * Four things, each one a criterion:
 *
 * 1. Scrolled to the bottom of every tall screen, the tab bar is on screen and
 *    is what a click there lands on — and neither a click nor a focus on a tab
 *    moves the page to get at it. The old header made Playwright scroll to the
 *    top before every tab click; the first version of *this* phase's header
 *    (`sticky`) made it scroll 364px, and made `focus()` on a tab do the same.
 * 2. Focus after a route change is below the header.
 * 3. Tab and Shift+Tab through a long page never leave focus under it —
 *    Shift+Tab especially, because scrolling *up* to a control is what aims it
 *    at the viewport's top edge.
 * 4. Moving from one list to another announces each list's own name.
 */
import { expect, test, type Page } from '../dict';

import { ready } from '../p3/helpers';

test.use({ dictionary: 'installed' });

const announcer = (page: Page) => page.getByTestId('route-announcer');

/** A shell with the wide arrangement actually in effect — it starts phone-shaped for one frame. */
async function wideReady(page: Page): Promise<void> {
  await ready(page);
  await expect(page.getByTestId('wide-shell')).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--shell-header-height'),
      ),
    )
    .not.toBe('');
}

/** How far down the page can go, once it has stopped growing. */
async function scrollToBottom(page: Page): Promise<number> {
  let previous = -1;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const max = await page.evaluate(() => {
      const bottom = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, bottom);
      return bottom;
    });
    if (max === previous) break;
    previous = max;
    await page.waitForTimeout(100);
  }
  await expect
    .poll(() =>
      page.evaluate(() =>
        Math.abs(
          document.documentElement.scrollHeight - window.innerHeight - window.scrollY,
        ),
      ),
    )
    .toBeLessThan(2);
  return page.evaluate(() => window.scrollY);
}

interface Box {
  top: number;
  bottom: number;
}

/** The header's bottom edge, in viewport coordinates. */
const headerBottom = (page: Page) =>
  page.evaluate(
    () => document.querySelector('[data-testid="shell-header"]')!.getBoundingClientRect().bottom,
  );

/** Where the focused element is, or null when nothing measurable has focus. */
async function focusedBox(
  page: Page,
): Promise<(Box & { inHeader: boolean; label: string; viewport: number }) | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const rect = el.getBoundingClientRect();
    // `sr-only` and zero-size controls have nowhere to be seen, above the
    // header or below it.
    if (rect.width * rect.height <= 1) return null;
    const header = document.querySelector('[data-testid="shell-header"]');
    return {
      top: rect.top,
      bottom: rect.bottom,
      inHeader: header?.contains(el) === true,
      label: `${el.tagName.toLowerCase()} "${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 40)}"`,
      viewport: window.innerHeight,
    };
  });
}

/**
 * Focus is visible: below the header, and above the bottom of the viewport.
 *
 * A control taller than what is left of the viewport cannot satisfy both; its
 * top edge is the one that matters — that is where a learner reads from — so
 * only the top is held for those.
 */
async function expectFocusClear(page: Page, context: string): Promise<void> {
  const box = await focusedBox(page);
  if (!box || box.inHeader) return;
  const clear = await headerBottom(page);
  expect(box.top, `${context}: ${box.label} is under the header`).toBeGreaterThanOrEqual(clear - 0.5);
  if (box.bottom - box.top <= box.viewport - clear) {
    expect(box.bottom, `${context}: ${box.label} is below the viewport`).toBeLessThanOrEqual(
      box.viewport + 0.5,
    );
  }
}

test.describe('the tab bar is in reach at any scroll depth', () => {
  /**
   * Library is the tallest screen the app has — the attribution notice is
   * rendered in full, as a licence obligation — and a lookup for `the` is the
   * tallest result list. Both, rather than trusting either to stay the longest.
   */
  for (const path of ['/library', '/?q=the']) {
    test(`at the bottom of ${path}, every tab is visible and is what a click there hits`, async ({
      page,
    }) => {
      await page.goto(path);
      await wideReady(page);
      if (path.includes('q=')) {
        await expect(page.getByTestId('lookup-input')).toHaveValue('the');
      }
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight))
        .toBeGreaterThan(1500);
      const bottom = await scrollToBottom(page);
      expect(bottom).toBeGreaterThan(1500);

      const bar = await page.getByTestId('tab-bar').boundingBox();
      expect(bar, 'the tab bar has no box').not.toBeNull();
      expect(bar!.y).toBeGreaterThanOrEqual(0);
      expect(bar!.y + bar!.height).toBeLessThanOrEqual(720);

      // What is actually at each tab's centre is that tab — not the page
      // scrolled under it, and not nothing.
      const hits = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-testid="tab-link"]')].map((link) => {
          const r = link.getBoundingClientRect();
          const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { tab: link.dataset.tab, hit: at !== null && link.contains(at) };
        }),
      );
      expect(hits).toEqual([
        { tab: 'lookup', hit: true },
        { tab: 'practice', hit: true },
        { tab: 'library', hit: true },
      ]);
    });
  }

  test('a real click on a tab from the bottom of Library does not scroll up first', async ({
    page,
  }) => {
    await page.goto('/library');
    await wideReady(page);
    const bottom = await scrollToBottom(page);
    expect(bottom).toBeGreaterThan(1500);

    // Where the page was at the moment the click reached the link. Playwright
    // scrolls a target into view before clicking it: with the old header that
    // meant scrolling to 0, and with a `sticky` one it meant 364px up, because
    // a stuck header's links sit inside the root's scroll padding and the
    // browser "scrolls them into view" by moving the page. Exact, because
    // either failure is a number and neither is `bottom`.
    await page.evaluate(() => {
      const link = document.querySelector('[data-tab="practice"]')!;
      link.addEventListener(
        'click',
        () => {
          (window as unknown as { __clickedAt: number }).__clickedAt = window.scrollY;
        },
        { capture: true, once: true },
      );
    });
    await page.getByTestId('tab-link').filter({ hasText: 'Practice' }).click();
    await expect(page.locator('[data-route="/practice"]')).toHaveCount(1);
    const clickedAt = await page.evaluate(
      () => (window as unknown as { __clickedAt?: number }).__clickedAt,
    );
    expect(clickedAt).toBe(bottom);
  });

  /**
   * The same failure as a learner meets it, with no Playwright in the path:
   * focusing a tab — from code, or a keyboard user arriving on it — must not
   * move the page. It did, 364px, while the header was `sticky`.
   */
  test('focusing a tab from deep in Library leaves the page where it was', async ({ page }) => {
    await page.goto('/library');
    await wideReady(page);
    await expect(page.getByTestId('list-card').first()).toBeVisible({ timeout: 30_000 });
    await scrollToBottom(page);
    const moved = await page.evaluate(() => {
      window.scrollTo(0, 3000);
      const before = window.scrollY;
      const results: number[] = [];
      for (const link of document.querySelectorAll<HTMLElement>('[data-testid="tab-link"]')) {
        link.focus();
        link.scrollIntoView({ block: 'nearest' });
        results.push(window.scrollY - before);
      }
      return results;
    });
    expect(moved).toEqual([0, 0, 0]);
  });
});

test.describe('focus is never under the header', () => {
  test('after a route change from deep in a page, the focused heading is below the header', async ({
    page,
  }) => {
    await page.goto('/library');
    await wideReady(page);
    await scrollToBottom(page);

    await page.getByTestId('tab-link').filter({ hasText: 'Practice' }).click();
    await expect(page.locator('[data-route="/practice"]')).toHaveCount(1);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-route-heading')))
      .toBe(true);
    await expectFocusClear(page, 'the Practice heading');
    const box = await focusedBox(page);
    expect(box).not.toBeNull();
  });

  /**
   * The whole of Library, forwards and then backwards, one Tab at a time.
   * Every control on the page gets focus once each way; every one of them is
   * checked. Backwards is the direction that matters — Shift+Tab scrolls *up*
   * to a control, and without `scroll-padding-top` the browser aligns it with
   * the viewport's top edge, which is exactly where the header now sits.
   */
  test('Tab and Shift+Tab through Library leave every control clear of the header', async ({
    page,
  }) => {
    await page.goto('/library');
    await wideReady(page);
    // The page grows as the lists and the stats arrive; tab through the whole
    // of it, not the first screen of it.
    await expect(page.getByTestId('list-card').first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight))
      .toBeGreaterThan(1500);

    // Start from the heading, so the first Tab is the first control of the page.
    await page.evaluate(() =>
      document.querySelector<HTMLElement>('[data-route-heading]')?.focus(),
    );

    let forward = 0;
    let deepest = 0;
    for (; forward < 250; forward += 1) {
      await page.keyboard.press('Tab');
      const box = await focusedBox(page);
      // Wrapped round into the header (or off the page): the page is done.
      if (forward > 0 && (box === null || box.inHeader)) {
        const onPage = await page.evaluate(
          () => document.querySelector('main')?.contains(document.activeElement) === true,
        );
        if (!onPage) break;
      }
      await expectFocusClear(page, `Tab #${forward + 1}`);
      deepest = Math.max(deepest, await page.evaluate(() => window.scrollY));
    }
    // It went somewhere worth testing: a page's worth of controls, far down —
    // and it finished, rather than running out of presses part-way.
    expect(forward).toBeGreaterThan(20);
    expect(forward, 'Library has more than 250 controls; raise the cap').toBeLessThan(250);
    expect(deepest).toBeGreaterThan(1000);

    // Back up from the last control on the page.
    await page.keyboard.press('Shift+Tab');
    let backward = 0;
    for (; backward < 250; backward += 1) {
      await expectFocusClear(page, `Shift+Tab #${backward + 1}`);
      const inMain = await page.evaluate(
        () => document.querySelector('main')?.contains(document.activeElement) === true,
      );
      if (!inMain) break;
      await page.keyboard.press('Shift+Tab');
    }
    expect(backward).toBeGreaterThan(20);
    // And it came all the way back up.
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(200);
  });

  /**
   * Back restores the offset and the announcer focuses the heading without
   * scrolling, on purpose — so the heading itself may be out of view, or
   * partly under the header (HANDOFF.md records why that is left alone: it
   * draws no focus ring, and scrolling it clear would undo the restore). What
   * a keyboard user does next is Tab, and that must land clear.
   */
  test('after Back restores a scrolled Library, the next Tab lands clear of the header', async ({
    page,
  }) => {
    await page.goto('/library');
    await wideReady(page);
    await expect(page.getByTestId('list-card').first()).toBeVisible({ timeout: 30_000 });
    await scrollToBottom(page);
    await page.evaluate(() => window.scrollTo(0, 1200));
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(1200);

    await page.getByTestId('tab-link').filter({ hasText: 'Practice' }).click();
    await expect(page.locator('[data-route="/practice"]')).toHaveCount(1);
    await page.goBack();
    await expect(page.locator('[data-route="/library"]')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(1100);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-route-heading')))
      .toBe(true);

    await page.keyboard.press('Tab');
    const box = await focusedBox(page);
    expect(box, 'Tab after Back focused nothing measurable').not.toBeNull();
    await expectFocusClear(page, 'the first Tab after Back');
  });

  test('a scroll to a section inside the page lands below the header', async ({ page }) => {
    // Library's "Change" beside the learner's level scrolls to the Study
    // section — the one in-page jump the app has.
    await page.goto('/library');
    await wideReady(page);
    await scrollToBottom(page);
    const change = page.getByTestId('learner-level-change');
    await expect(change).toBeVisible({ timeout: 30_000 });
    await change.click();

    // It is a smooth scroll; wait for it to stop.
    let last = -1;
    await expect
      .poll(async () => {
        const now = await page.evaluate(() => window.scrollY);
        const settled = now === last;
        last = now;
        return settled;
      })
      .toBe(true);
    const top = await page.evaluate(
      () => document.getElementById('library-study')!.getBoundingClientRect().top,
    );
    expect(top).toBeGreaterThanOrEqual((await headerBottom(page)) - 0.5);
  });
});

test.describe('each list is announced by its own name', () => {
  test('list A, then list B, then straight back to A', async ({ page }) => {
    await page.goto('/library');
    await wideReady(page);
    const [a, b] = await page.evaluate(async () => {
      const repo = window.__tangram.repo;
      const stamp = Date.now();
      const first = await repo.createList({ name: `Verbs ${stamp}`, kind: 'custom' });
      const second = await repo.createList({ name: `Food ${stamp}`, kind: 'custom' });
      return [first, second].map((list) => ({ id: list.id, name: list.name }));
    });
    // Every string the live region ever holds, in order, so a wrong name that
    // was spoken and then corrected still fails.
    await page.evaluate(() => {
      const region = document.querySelector('[data-testid="route-announcer"]')!;
      const said: string[] = [];
      (window as unknown as { __said: string[] }).__said = said;
      new MutationObserver(() => {
        const text = region.textContent?.trim() ?? '';
        if (text !== '') said.push(text);
      }).observe(region, { childList: true, subtree: true, characterData: true });
    });
    const said = () => page.evaluate(() => (window as unknown as { __said: string[] }).__said);

    // The Library screen reads its lists once, on mount; come back to it.
    await page.getByTestId('tab-link').filter({ hasText: 'Practice' }).click();
    await expect(announcer(page)).toHaveText('Practice');
    await page.getByTestId('tab-link').filter({ hasText: 'Library' }).click();
    await expect(announcer(page)).toHaveText('Library');

    const open = async (list: { id: string; name: string }) => {
      await page
        .getByTestId('list-card')
        .filter({ hasText: list.name })
        .getByRole('link', { name: list.name })
        .click();
      await expect(page).toHaveURL(new RegExp(`/library/lists/${list.id}$`));
    };

    await open(a!);
    await expect(announcer(page)).toHaveText(a!.name);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(a!.name);
    await expectFocusClear(page, 'list A heading');

    // The way back is there, and says where it goes.
    await page.getByTestId('list-breadcrumb').click();
    await expect(announcer(page)).toHaveText('Library');

    await open(b!);
    await expect(announcer(page)).toHaveText(b!.name);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(b!.name);

    // Straight from B to A: one history jump, so the list page never unmounts
    // and the heading holds B's name until A's read lands. This is the case the
    // wait in the announcer exists for.
    await page.evaluate(() => history.go(-2));
    await expect(page).toHaveURL(new RegExp(`/library/lists/${a!.id}$`));
    await expect(announcer(page)).toHaveText(a!.name);

    expect(await said()).toEqual(['Practice', 'Library', a!.name, 'Library', b!.name, a!.name]);
  });
});
