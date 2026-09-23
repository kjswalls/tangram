/**
 * Three defects the first-run audit found and left written up (HANDOFF.md,
 * "The first-run audit" — "Defects found, not fixed" 4 and 5, and "Defects
 * fixed" 7's reversal), held by what the learner or the deployer sees.
 *
 * 1. Picking a lower search result on a phone left its headword above the
 *    viewport. Asserted **every frame** from the click, because the defect was
 *    a race: a check taken after things settle passes on a page that showed
 *    the wrong scroll for a second.
 * 2. Library said "no words yet" for a band whose count had not arrived.
 * 3. The failed-download screen could not say which of "not on the server",
 *    "could not reach it" and "the browser refused it" had happened.
 */
import { expect, test, type Page } from '../dict';

const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 800 };
/**
 * Narrow (the panel leads) but tall enough that result rows show under it —
 * the shape where scroll anchoring picks a row drawn below the panel.
 */
const TALL = { width: 700, height: 2200 };

/**
 * Record, every animation frame for `ms` after `action`, whether the panel's
 * headword is fully inside the band the page leaves clear: below the root's
 * `scroll-padding-top` (the wide shell's pinned header), above its
 * `scroll-padding-bottom` (the phone's tab bar), and inside the panel column's
 * own scroll box on a wide screen, where the column scrolls by itself.
 *
 * Frames while the panel still heads with `before` (the query, before the pick
 * lands) are skipped — that is the previous state, not this one — and every
 * frame after must be in view.
 */
async function headwordFrames(page: Page, before: string, action: () => Promise<void>, ms = 1500) {
  await page.evaluate(
    ({ before, ms }) => {
      const w = window as unknown as { __frames: string[]; __framesDone: boolean };
      w.__frames = [];
      w.__framesDone = false;
      const start = performance.now();
      const tick = () => {
        const head = document.querySelector<HTMLElement>('[data-testid="lookup-panel"] h2');
        if (head && head.textContent !== before) {
          const root = getComputedStyle(document.documentElement);
          const top = parseFloat(root.scrollPaddingTop) || 0;
          const bottom = innerHeight - (parseFloat(root.scrollPaddingBottom) || 0);
          const rect = head.getBoundingClientRect();
          const column = document.querySelector<HTMLElement>('[data-testid="lookup-panel-column"]');
          const clip = column && column.scrollHeight > column.clientHeight ? column.getBoundingClientRect() : null;
          const ok =
            rect.top >= top - 0.5 &&
            rect.bottom <= bottom + 0.5 &&
            (!clip || (rect.top >= clip.top - 0.5 && rect.bottom <= clip.bottom + 0.5));
          w.__frames.push(ok ? 'ok' : `top ${Math.round(rect.top)} bottom ${Math.round(rect.bottom)} band ${Math.round(top)}–${Math.round(bottom)} y ${Math.round(scrollY)}`);
        }
        if (performance.now() - start < ms) requestAnimationFrame(tick);
        else w.__framesDone = true;
      };
      requestAnimationFrame(tick);
    },
    { before, ms },
  );
  await action();
  await page.waitForFunction(() => (window as unknown as { __framesDone: boolean }).__framesDone);
  return page.evaluate(() => (window as unknown as { __frames: string[] }).__frames);
}

test.describe('picking a lower search result keeps its headword in view', () => {
  test.use({ dictionary: 'installed' });

  for (const [name, viewport] of [
    ['390×844', PHONE],
    ['1280×800', WIDE],
    ['700×2200', TALL],
  ] as const) {
    // The audit's two: result 10 and result 18 of `?q=the`, measured 30–73px
    // high on a phone.
    for (const index of [9, 17]) {
      test(`result ${index + 1} of ?q=the at ${name}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto('/?q=the');
        const result = page.getByTestId('search-result').nth(index);
        await expect(result).toBeVisible();
        await result.scrollIntoViewIfNeeded();
        await expect(page.getByTestId('lookup-panel').locator('h2')).toHaveText('the');

        const frames = await headwordFrames(page, 'the', () => result.click());
        expect(frames.length, 'the headword was drawn at all').toBeGreaterThan(0);
        expect(frames.filter((frame) => frame !== 'ok')).toEqual([]);
      });
    }
  }
});

test.describe('Library never says "no words yet" for a band still being counted', () => {
  test.use({ dictionary: 'installed' });

  test('on the first visit, every frame', async ({ page }) => {
    // Every frame from the first paint, not a check after the fill: the
    // defect was a moment, and a settled page does not show it.
    await page.addInitScript(() => {
      const w = window as unknown as { __wrong: string[]; __states: Set<string> };
      w.__wrong = [];
      w.__states = new Set();
      const tick = () => {
        for (const card of document.querySelectorAll<HTMLElement>('[data-testid="list-card"][data-list-kind="hsk"]')) {
          const counts = card.querySelector<HTMLElement>('[data-testid="list-counts"]');
          if (!counts) continue;
          w.__states.add(counts.dataset.countState ?? '');
          if (/no words yet/.test(counts.textContent ?? '')) w.__wrong.push(card.dataset.listName ?? '?');
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto('/library');
    const cards = page.locator('[data-testid="list-card"][data-list-kind="hsk"]');
    await expect(cards).toHaveCount(7);
    // The fill ends with every band counted.
    await expect(page.getByTestId('lists-filling')).toHaveCount(0, { timeout: 60_000 });
    for (const card of await cards.all()) await expect(card.getByTestId('list-count')).toHaveText(/^\d+$/);

    const { wrong, states } = await page.evaluate(() => {
      const w = window as unknown as { __wrong: string[]; __states: Set<string> };
      return { wrong: [...new Set(w.__wrong)], states: [...w.__states] };
    });
    expect(wrong).toEqual([]);
    // …and the page really did pass through the state the defect lived in.
    expect(states).toContain('counting');
  });
});

test.describe('the failed-download screen says what happened, in plain words', () => {
  const MANIFEST = '**/dict-manifest.json';
  const cases = [
    {
      name: 'the server has no manifest (404)',
      route: (page: Page) => page.route(MANIFEST, (route) => route.fulfill({ status: 404, body: 'not found' })),
      diagnosis: 'not-on-server',
    },
    {
      name: 'the server has the manifest but not the file (404)',
      route: (page: Page) => page.route('**/*.sqlite*', (route) => route.fulfill({ status: 404, body: 'not found' })),
      diagnosis: 'not-on-server',
    },
    {
      name: 'an SPA fallback answers the manifest with a page',
      route: (page: Page) =>
        page.route(MANIFEST, (route) =>
          route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Tangram</title>' }),
        ),
      diagnosis: 'served-page',
    },
    {
      name: 'the network drops the file',
      route: (page: Page) => page.route('**/*.sqlite*', (route) => route.abort('failed')),
      diagnosis: 'unreachable',
    },
  ] as const;

  for (const { name, route, diagnosis } of cases) {
    test(name, async ({ page }) => {
      const warnings: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'warning') warnings.push(message.text());
      });
      await route(page);
      await page.goto('/');
      await page.getByTestId('dict-start').click();
      const status = page.getByTestId('dict-gate').getByTestId('dict-status');
      await expect(status).toHaveAttribute('data-state', 'failed');
      await expect(status).toHaveAttribute('data-diagnosis', diagnosis);
      await expect(status.getByTestId('dict-failure-diagnosis')).toBeVisible();
      // Plain words: no raw error, no status code, no monospace detail line.
      await expect(status.getByTestId('dict-failure-detail')).toHaveCount(0);
      await expect(status).not.toContainText(/TypeError|Failed to fetch|JSON|SQLite|\b40\d\b/);
      // The raw detail still reaches the console, where a desk can read it.
      expect(warnings.some((text) => text.startsWith('tangram: the dictionary failed — '))).toBe(true);
    });
  }
});
