/**
 * The first-run audit's defects, held by geometry rather than by screenshot
 * (HANDOFF.md, "The first-run audit", 2026-09-23).
 *
 * The audit drove the production build as a new learner at 390×844, 1280×800
 * and 844×390 and measured every screen. Each case here is one thing it found
 * that 300-odd green specs had not: the tab label that wrapped, the result
 * count before any query, the targets under 44px on a touch screen, focus
 * landing under the phone's tab bar, the reader heading cut to one character,
 * two rows whose text a pair of buttons squeezed to nothing, and the raw
 * `TypeError` on the failed-download screen.
 *
 * Touch cases run with `hasTouch`, which makes Chromium report
 * `(pointer: coarse)` — the query the 44px rule is scoped to. The other specs
 * at 390px run with a mouse, as a narrow desktop window would.
 */
import { expect, test, type Page } from '../dict';
import { DASUAN, openReview, readerContext, seed } from '../p2/fixtures';

const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 800 };
const LANDSCAPE = { width: 844, height: 390 };

/** Every tab label renders on one line. */
async function tabLineCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const out: Record<string, number> = {};
    for (const link of document.querySelectorAll<HTMLElement>('[data-testid="tab-link"]')) {
      const range = document.createRange();
      range.selectNodeContents(link);
      // One line box → every client rect shares one top.
      const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
      out[(link.textContent ?? '').trim()] = tops.size;
    }
    return out;
  });
}

/**
 * The controls whose effective touch target — the box, or the `::after` a
 * `.touch-target` gains under a coarse pointer, whichever is larger — is under
 * 44px either way. Exempt, as WCAG 2.5.5 exempts them: a link or button inside
 * a sentence (it is part of running text), the reader's own words (the text is
 * the target), and anything inside an SVG chart (its table is the equivalent).
 */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selector =
      'a[href],button,select,textarea,summary,input:not([type=hidden]),[role=button],[tabindex]:not([tabindex="-1"])';
    const out: string[] = [];
    const size = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const after = getComputedStyle(el, '::after');
      const extended = after.content !== 'none' && after.position === 'absolute';
      return {
        w: Math.max(rect.width, extended ? parseFloat(after.width) || 0 : 0),
        h: Math.max(rect.height, extended ? parseFloat(after.height) || 0 : 0),
      };
    };
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width < 2) continue;
      if (el.closest('[aria-hidden="true"],[inert],svg,.sr-only')) continue;
      if ((el as HTMLButtonElement).disabled) continue;
      if (el.matches('[data-testid="reader-token"]')) continue;
      const sentence = el.closest('p, li, dd, td');
      if (sentence && (sentence.textContent ?? '').trim().length > (el.textContent ?? '').trim().length + 10) continue;
      // A checkbox or radio is reached through its label.
      const target =
        el.matches('input[type=checkbox],input[type=radio]') && el.closest('label') ? el.closest('label')! : el;
      if (el.matches('input[type=file]') && el.classList.contains('sr-only')) continue;
      const { w, h } = size(target);
      if (w < 43.5 || h < 43.5) {
        const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
        out.push(`${el.tagName.toLowerCase()} "${name}" ${Math.round(w)}×${Math.round(h)}`);
      }
    }
    return out;
  });
}

/**
 * Library's cards fill in after first paint and grow the page; a focus scroll
 * taken while that is still happening is undone by the growth above it. Wait
 * for three equal height readings, as `core/routing.spec.ts` does.
 */
async function settled(page: Page): Promise<void> {
  let last = -1;
  let same = 0;
  for (let i = 0; i < 60 && same < 3; i += 1) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    same = height === last ? same + 1 : 0;
    last = height;
    await page.waitForTimeout(100);
  }
}

/** Press Tab until focus leaves `<main>` for the tab bar; report any control focused under the bar. */
async function focusUnderTabBar(page: Page, presses = 80): Promise<string[]> {
  const hidden: string[] = [];
  for (let i = 0; i < presses; i += 1) {
    await page.keyboard.press('Tab');
    const verdict = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      const bar = document.querySelector('[data-testid="tab-bar"]');
      if (!active || !bar || active === document.body) return { done: false, hidden: null };
      if (bar.contains(active)) return { done: true, hidden: null };
      const rect = active.getBoundingClientRect();
      const barTop = bar.getBoundingClientRect().top;
      const name = (active.getAttribute('aria-label') ?? active.textContent ?? '').trim().slice(0, 30);
      return { done: false, hidden: rect.bottom > barTop + 1 ? `${active.tagName} "${name}"` : null };
    });
    if (verdict.hidden) hidden.push(verdict.hidden);
    if (verdict.done) break;
  }
  return hidden;
}

test.describe('the tab labels do not wrap', () => {
  for (const [name, viewport] of [
    ['1280×800', WIDE],
    ['844×390', LANDSCAPE],
    ['390×844', PHONE],
  ] as const) {
    test(`at ${name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/library');
      await expect(page.getByTestId('tab-link').first()).toBeVisible();
      // "Look up" broke onto two lines in the wide header at 844 and 1280.
      expect(await tabLineCounts(page)).toEqual({ 'Look up': 1, Practice: 1, Library: 1 });
    });
  }
});

test.describe('the failed-download screen', () => {
  test('names the reason and offers a retry, and shows no raw error', async ({ page }) => {
    await page.route('**/*.sqlite*', (route) => route.abort('failed'));
    await page.goto('/');
    await page.getByTestId('dict-start').click();
    const status = page.getByTestId('dict-gate').getByTestId('dict-status');
    await expect(status).toHaveAttribute('data-state', 'failed');
    await expect(status.getByTestId('dict-retry')).toBeVisible();
    // It read "the dictionary could not be fetched: TypeError: Failed to fetch".
    await expect(status.getByTestId('dict-failure-detail')).toHaveCount(0);
    await expect(status).not.toContainText(/TypeError|Failed to fetch/);
  });
});

test.describe('a phone with a touch screen, before the dictionary', () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test('Library: every control is a 44px target, and Tab never hides focus under the tab bar', async ({ page }) => {
    await page.goto('/library');
    await expect(page.getByTestId('list-card').first()).toBeVisible();
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    expect(await smallTargets(page)).toEqual([]);

    await settled(page);
    await page.getByRole('heading', { level: 1 }).focus();
    expect(await focusUnderTabBar(page, 200)).toEqual([]);
  });
});

test.describe('a phone with a touch screen, with the dictionary', () => {
  test.use({ viewport: PHONE, hasTouch: true, dictionary: 'installed' });

  test('Look up, the reader and a list: counts, targets, headings and rows', async ({ page }) => {
    // The empty box: no count at all. It said "No matches".
    await page.goto('/');
    await expect(page.getByTestId('lookup-status')).toContainText('Tones are optional');
    await expect(page.getByTestId('result-count')).toHaveCount(0);

    // A picked result: every control a 44px target.
    await page.goto('/?q=%E6%89%93%E7%AE%97');
    await page.getByTestId('search-result').first().click();
    await expect(page.getByTestId('entry-detail')).toBeVisible();
    expect(await smallTargets(page)).toEqual([]);

    // The reader: the heading keeps its row rather than shrinking to a glyph.
    await page.goto('/read');
    await page.getByTestId('reader-input').fill('我今天打算去图书馆看书。那里很安静，我可以学习汉语。');
    await page.getByTestId('read-text').click();
    const heading = page.getByTestId('reader-heading');
    await expect(heading).toBeVisible();
    const headingWidth = (await heading.boundingBox())!.width;
    expect(headingWidth).toBeGreaterThanOrEqual(12 * 16);

    // The importer's preview row with a reading picker, and a custom list's
    // rows: the gloss keeps the room to be read.
    await page.goto('/library');
    await page.getByTestId('import-open').click();
    await page.getByLabel('Words to import').fill('了\n跑步\n');
    await page.getByLabel('Imported list name').fill('Audit');
    await page.getByTestId('import-preview').click();
    const pickRow = page.getByTestId('import-row').filter({ has: page.locator('select') }).first();
    await expect(pickRow).toBeVisible();
    const pickWord = (await pickRow.locator('span').first().boundingBox())!.width;
    expect(pickWord).toBeGreaterThanOrEqual(12 * 16);
    expect(await smallTargets(page)).toEqual([]);

    await page.getByTestId('import-submit').click();
    await expect(page.getByTestId('import-result')).toBeVisible();
    // With writing on, so the list's "Also write these words from memory"
    // checkbox is drawn too.
    await page.evaluate(() => window.__tangram?.repo.setSettings({ productionDirection: true }));
    await page.goto('/library');
    await page.getByRole('link', { name: 'Audit' }).first().click();
    await expect(page.getByTestId('list-production')).toBeVisible();
    const member = page.getByTestId('list-member').first();
    await expect(member).toBeVisible();
    const gloss = member.locator('span.block.truncate');
    const glossWidth = (await gloss.boundingBox())!.width;
    // It was ~50px — "to run; t…" — beside Remove and Add to queue.
    expect(glossWidth).toBeGreaterThanOrEqual(12 * 16);
    expect(await smallTargets(page)).toEqual([]);
  });
});

test.describe('a phone, on the back of a card', () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test('Tab and Shift+Tab never leave focus under the grade buttons', async ({ page }) => {
    // Enough senses for "Other senses" and a context line, so the back has
    // controls above the dock and a page tall enough to scroll.
    const long = {
      ...DASUAN,
      glosses: Array.from({ length: 12 }, (_, i) => `sense number ${i + 1} of a long entry`),
    };
    await openReview(page);
    // Writing on, so the back carries "Also write it from memory" — the one
    // control a back always has in this container (there is no voice, so the
    // speaker is disabled).
    await page.evaluate(() => window.__tangram?.repo.setSettings({ productionDirection: true }));
    await seed(page, [{ entry: long, context: readerContext() }]);
    await page.goto('/practice');
    await page.getByTestId('reveal').click();
    await expect(page.getByTestId('grade-dock')).toBeVisible();

    const underDock = () =>
      page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        const dock = document.querySelector('[data-testid="grade-dock"]');
        if (!active || !dock || dock.contains(active) || active === document.body) return null;
        const box = active.getBoundingClientRect();
        const top = dock.getBoundingClientRect().top;
        return box.bottom > top + 1 ? `${active.tagName} "${(active.textContent ?? '').trim().slice(0, 30)}"` : null;
      });

    const hidden: string[] = [];
    const visited = new Set<string>();
    await page.getByTestId('grade-1').focus();
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Shift+Tab');
      const where = await underDock();
      if (where) hidden.push(`back: ${where}`);
      visited.add(await page.evaluate(() => (document.activeElement?.textContent ?? '').trim().slice(0, 30)));
      if (await page.getByTestId('wordmark').evaluate((el) => el === document.activeElement)) break;
    }
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab');
      const where = await underDock();
      if (where) hidden.push(`forward: ${where}`);
      if (await page.getByTestId('grade-1').evaluate((el) => el === document.activeElement)) break;
    }
    // The walk has to have crossed the card, or it proves nothing.
    expect([...visited].some((text) => /write it from memory/i.test(text)), [...visited].join(' | ')).toBe(true);
    expect(hidden).toEqual([]);
  });
});
