import { expect, test, type Page } from '@playwright/test';

/**
 * /lookup — the front door (PLAN.md §1). One input; results grouped by headword;
 * a panel that can turn the one you meant into a card that remembers the query it
 * came from.
 *
 * State is read back through `window.__tangram.repo`, the test hook the shell
 * mounts, rather than through the UI: "the card exists and carries its context" is
 * a claim about IndexedDB, and asserting it on a rendered label would pass even if
 * nothing were written.
 */

interface StoredCard {
  entryId: string | null;
  senseIndex?: number;
  context?: { query?: string; source?: string; addedAt?: number };
  snapshot: { simp: string; pinyinMarked: string; hskBand?: number; dictVersion: string };
}

interface TangramWindow {
  __tangram: { repo: { allCards(): Promise<StoredCard[]>; resetAll(): Promise<void> } };
}

async function openLookup(page: Page): Promise<void> {
  await page.goto('/lookup');
  await expect(page.getByTestId('lookup-input')).toBeVisible();
  await page.evaluate(async () => {
    await (window as unknown as TangramWindow).__tangram.repo.resetAll();
  });
}

/** Type a query and wait for the results on screen to be the ones it produced. */
async function look(page: Page, query: string): Promise<void> {
  await page.getByTestId('lookup-input').fill(query);
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-query', query);
}

function cards(page: Page): Promise<StoredCard[]> {
  return page.evaluate(async () =>
    (window as unknown as TangramWindow).__tangram.repo.allCards(),
  );
}

const result = (page: Page) => page.getByTestId('search-result');

test.describe('searching', () => {
  test('a reading finds the word, with its band, its readings and where it matched', async ({
    page,
  }) => {
    await openLookup(page);
    await look(page, 'dasuan');

    const first = result(page).first();
    await expect(first).toContainText('打算');
    await expect(first.getByTestId('result-readings')).toContainText('dǎsuàn');
    await expect(first.getByTestId('hsk-badge')).toHaveText('HSK 2');
    await expect(first.getByTestId('match-source')).toHaveText('pinyin');
  });

  test('the same word answers to tone marks, tone numbers and a prefix', async ({ page }) => {
    await openLookup(page);
    for (const query of ['dǎsuàn', 'da3suan4']) {
      await look(page, query);
      await expect(result(page).first()).toContainText('打算');
    }
    await look(page, 'dasu');
    await expect(result(page).filter({ hasText: '打算' }).first()).toBeVisible();
  });

  test('an English word finds it too, in the labelled English section', async ({ page }) => {
    await openLookup(page);
    await look(page, 'plan');
    const first3 = await result(page).evaluateAll((nodes) =>
      nodes.slice(0, 3).map((node) => node.textContent ?? ''),
    );
    expect(first3.join(' ')).toContain('打算');
    await expect(page.getByTestId('section-english')).toBeVisible();
  });

  test('a query that is both a reading and an English word answers as both', async ({ page }) => {
    await openLookup(page);
    await look(page, 'sun');
    // English leads for a three-letter gloss word, but the reading is right there.
    await expect(page.getByTestId('section-english')).toContainText('太阳');
    await expect(page.getByTestId('section-pinyin')).toContainText('孙');
  });

  test('"show more" pages past the cap of 50', async ({ page }) => {
    await openLookup(page);
    await look(page, 'yi');
    await expect(result(page)).toHaveCount(50);
    await expect(page.getByTestId('result-count')).toContainText('of');
    await page.getByTestId('show-more').click();
    await expect(async () => {
      expect(await result(page).count()).toBeGreaterThan(50);
    }).toPass();
  });

  test('emptying the box clears the results', async ({ page }) => {
    await openLookup(page);
    await look(page, 'dasuan');
    await page.getByTestId('lookup-input').fill('');
    await expect(result(page)).toHaveCount(0);
    await expect(page.getByTestId('lookup-panel')).toBeVisible();
  });
});

test.describe('the panel', () => {
  test('shows the entry: both scripts, every reading, classifier and characters', async ({
    page,
  }) => {
    await openLookup(page);
    await look(page, 'dasuan');
    await result(page).first().click();

    const detail = page.getByTestId('entry-detail');
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId('reading-pinyin').first()).toHaveText('dǎsuàn');
    await expect(detail).toContainText('to plan');
    await expect(detail).toContainText('个');
    await expect(detail.getByTestId('decomposition')).toContainText('⿰扌丁');
    await expect(detail.getByTestId('decomposition')).toContainText('⺮');
    // Nobody injects a slot on this route — Phase 4 made the ask panel the
    // panel's own default content instead, so the region is `lookup-ask`.
    await expect(page.getByTestId('lookup-ask-slot')).toHaveCount(0);
    await expect(page.getByTestId('lookup-ask')).toBeVisible();
    await expect(page.getByTestId('ask-panel')).toBeVisible();
  });

  test('Add writes a card that carries the query it came from', async ({ page }) => {
    await openLookup(page);
    await look(page, 'dasuan');
    await result(page).first().click();
    await page.getByTestId('add-card').click();
    await expect(page.getByTestId('add-state')).toContainText('Added');

    const saved = await cards(page);
    expect(saved).toHaveLength(1);
    expect(saved[0].entryId).toBe('打算|打算[da3 suan4]');
    expect(saved[0].context?.query).toBe('dasuan');
    expect(saved[0].context?.source).toBe('lookup');
    expect(saved[0].context?.addedAt).toBeGreaterThan(0);
    expect(saved[0].snapshot.simp).toBe('打算');
    expect(saved[0].snapshot.hskBand).toBe(2);
    // The card records which dictionary snapshot it was cut from.
    expect(saved[0].snapshot.dictVersion).toMatch(/\d/);
  });

  test('a polyphone makes you choose a reading, and Add honours the choice', async ({ page }) => {
    await openLookup(page);
    await look(page, '了');
    await result(page).first().click();

    const options = page.getByTestId('reading-option');
    await expect(options).toHaveCount(2);
    // The most frequent reading is preselected and named on the button…
    await expect(options.first()).toBeChecked();
    await expect(page.getByTestId('add-card')).toHaveText('Add le');

    // …and choosing the other one is what gets added.
    await page.locator('input[data-testid="reading-option"][value="了|了[liao3]"]').check();
    await expect(page.getByTestId('add-card')).toHaveText('Add liǎo');
    await page.getByTestId('add-card').click();
    await expect(page.getByTestId('add-card')).toHaveText('In your cards');

    const saved = await cards(page);
    expect(saved).toHaveLength(1);
    expect(saved[0].entryId).toBe('了|了[liao3]');
    expect(saved[0].snapshot.pinyinMarked).toBe('liǎo');
  });

  test('a single-reading word adds without a choice', async ({ page }) => {
    await openLookup(page);
    await look(page, 'dasuan');
    await result(page).first().click();
    await expect(page.getByTestId('reading-option')).toHaveCount(0);
    await expect(page.getByTestId('add-card')).toHaveText('Add card');
  });
});
