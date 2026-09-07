import { expect, test, type Page } from '@playwright/test';

/**
 * The post-merge integration spec (PLAN.md §4, "Phases 1–3").
 *
 * One walk of the loop the whole product is for, across all three merged
 * phases and touching no fixture: **look up 打算 → Add → Today shows 1 new →
 * /review shows 打算 → grade 3 → a `reviews` row exists → the nav reaches every
 * route.** Each phase's own suite proves its half in isolation; this is the one
 * spec that fails if the seams between them are wrong — the card P1 writes has
 * to be the card P3 counts and P2 offers, or nothing here passes.
 *
 * `newPerDay: 0` is deliberate: with the spine draw switched off, "1 new" is
 * exactly the word that was looked up, which is also the §3.3 rule that an
 * explicit Add is never subject to the daily cap.
 */

const DASUAN = '打算|打算[da3 suan4]';

const ROUTES = [
  { path: '/', label: 'Today', heading: 'Today' },
  { path: '/lookup', label: 'Lookup', heading: 'Lookup' },
  { path: '/review', label: 'Review', heading: 'Review' },
  { path: '/read', label: 'Read', heading: 'Read' },
  { path: '/lists', label: 'Lists', heading: 'Lists' },
  { path: '/settings', label: 'Settings', heading: 'Settings' },
] as const;

/** The layout mounts the test hook in an effect, so a fresh page waits for it. */
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => '__tangram' in window);
}

test('the loop: look up 打算, add it, meet it on Today, review it, grade it', async ({ page }) => {
  // A clean database, from the one route that neither draws cards nor
  // materialises a list, so the wipe cannot race the page it happens on.
  await page.goto('/settings');
  await ready(page);
  await page.evaluate(async () => {
    await window.__tangram.repo.resetAll();
    await window.__tangram.repo.setSettings({ newPerDay: 0 });
  });

  // --- look it up (P1) -----------------------------------------------------
  await page.goto('/lookup');
  await page.getByTestId('lookup-input').fill('dasuan');
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-query', 'dasuan');
  const first = page.getByTestId('search-result').first();
  await expect(first).toContainText('打算');
  await first.click();

  await expect(page.getByTestId('entry-detail')).toBeVisible();
  await page.getByTestId('add-card').click();
  await expect(page.getByTestId('add-state')).toContainText('Added');

  // The card exists, carries the query it came from, and names the dictionary
  // snapshot it was cut from — provenance is the product's second commitment.
  const saved = await page.evaluate(() => window.__tangram.repo.allCards());
  expect(saved).toHaveLength(1);
  expect(saved[0].entryId).toBe(DASUAN);
  expect(saved[0].context?.source).toBe('lookup');
  expect(saved[0].context?.query).toBe('dasuan');
  expect(saved[0].snapshot.dictVersion).toMatch(/\d/);

  // …and the Add joined the "Looked up" system list (P1 adding through P3's
  // `addCardTracked`, the seam the merge wired).
  const lookedUp = await page.evaluate(async () => {
    const repo = window.__tangram.repo;
    const list = (await repo.lists()).find((row) => row.kind === 'looked-up');
    return list ? (await repo.listMembers(list.id)).map((member) => member.entryId) : null;
  });
  expect(lookedUp).toContain(DASUAN);

  // --- Today counts it (P3) ------------------------------------------------
  await page.goto('/');
  await expect(page.getByTestId('today-new-count')).toHaveText('1');
  await expect(page.getByTestId('today-new-list')).toContainText('打算');

  // --- review it (P2) ------------------------------------------------------
  await page.getByTestId('start-review').click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByTestId('card-front')).toContainText('打算');

  await page.keyboard.press('Space');
  await expect(page.getByTestId('card-back')).toBeVisible();
  await expect(page.getByTestId('card-pinyin')).toHaveText('dǎsuàn');
  await page.keyboard.press('3');

  // The grade reached the database: one review row for this card, carrying the
  // rating and the pre-grade state, and the card is rescheduled forward.
  await expect(page.getByTestId('review-empty')).toBeVisible();
  const rows = await page.evaluate(() => window.__tangram.db.reviews.toArray());
  expect(rows).toHaveLength(1);
  expect(rows[0].cardId).toBe(saved[0].id);
  expect(rows[0].rating).toBe(3);
  expect(rows[0].before.state).toBe(0);

  const after = await page.evaluate(() => window.__tangram.repo.allCards());
  expect(after[0].fsrs.state).not.toBe(0);
  expect(after[0].due).toBeGreaterThan(Date.now());
});

test('the nav reaches every route with the card in place', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const route of ROUTES.slice(1)) {
    await nav.getByRole('link', { name: route.label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${route.path}$`));
    await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
  }
  await nav.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
});
