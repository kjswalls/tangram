/**
 * `/lists` (PLAN.md §4 P3): the eight system lists, the active toggle, marking a
 * band known, and a list of your own.
 */
import { expect, test } from '@playwright/test';

import { ready, resetApp } from './helpers';

const HSK_NAMES = ['HSK 1', 'HSK 2', 'HSK 3', 'HSK 4', 'HSK 5', 'HSK 6', 'HSK 7–9'];

test.describe('lists', () => {
  test('seven HSK lists and Looked up appear on the first visit', async ({ page }) => {
    await resetApp(page);
    await page.goto('/library');
    await ready(page);

    const cards = page.getByTestId('list-card');
    await expect(cards).toHaveCount(8);
    for (const name of ['Looked up', ...HSK_NAMES]) {
      await expect(page.locator(`[data-list-name="${name}"]`)).toHaveCount(1);
    }
    // They are rows in the database, not decoration: a reload finds the same ids.
    const stored = await page.evaluate(() => window.__tangram.repo.lists());
    expect(stored).toHaveLength(8);
    expect(stored.filter((list) => list.kind === 'hsk')).toHaveLength(7);
    expect(stored.filter((list) => list.kind === 'looked-up')).toHaveLength(1);
    expect(stored.every((list) => list.owner === 'system')).toBe(true);
  });

  test('an HSK list fills in its words and counts them', async ({ page }) => {
    await resetApp(page);
    await page.goto('/library');
    const band1 = page.locator('[data-list-name="HSK 1"]');
    await expect(band1.getByTestId('list-count')).toHaveText(/\d+/, { timeout: 60_000 });
    expect(Number(await band1.getByTestId('list-count').innerText())).toBeGreaterThan(400);
  });

  test('the active toggle persists', async ({ page }) => {
    await resetApp(page);
    await page.goto('/library');
    const band6 = page.locator('[data-list-name="HSK 6"]');
    await expect(band6).toHaveAttribute('data-active', 'true');
    await band6.getByRole('checkbox').uncheck();
    await expect(band6).toHaveAttribute('data-active', 'false');

    // The checkbox is optimistic (`lib/stores/lists.ts`), so the attribute flips
    // before Dexie has the write. Reloading on the strength of it races the
    // write against the navigation that kills the page running it — wait for the
    // row itself, which is what "persists" actually means.
    await expect
      .poll(async () =>
        page.evaluate(async () =>
          (await window.__tangram.repo.lists()).find((list) => list.name === 'HSK 6')?.active,
        ),
      )
      .toBe(false);

    await page.reload();
    await expect(page.locator('[data-list-name="HSK 6"]')).toHaveAttribute('data-active', 'false');
    const stored = await page.evaluate(() => window.__tangram.repo.lists());
    expect(stored.find((list) => list.name === 'HSK 6')?.active).toBe(false);
  });

  test('opening a list shows its words with their state', async ({ page }) => {
    // **The band assumption, stated.** core.md C8 made `knownBand` default to
    // 0 — "assume nothing known" — because the old default of 2 silently
    // cancelled the new `spineStartBand: 1`. So a band-1 word now reads `new`
    // on a fresh database, and a spec about the *known* state has to say which
    // learner it is about.
    await resetApp(page, { knownBand: 2 });
    await page.goto('/library');
    await page.locator('[data-list-name="HSK 1"]').getByRole('link', { name: 'Open' }).click();
    await expect(page).toHaveURL(/\/library\/lists\/[0-9a-f-]+$/);

    const members = page.getByTestId('list-member');
    await expect(members.first()).toBeVisible({ timeout: 60_000 });
    // With `knownBand: 2`, every band-1 word already reads as known.
    await expect(members.first()).toHaveAttribute('data-state', 'known');
    await expect(page.getByTestId('member-total')).toContainText('words');
  });

  test('…and with nothing assumed known, the same words read as new', async ({ page }) => {
    // The default a new learner actually gets. Worth its own case: "known by
    // assumption" and "known because you said so" look identical on screen,
    // and C8's whole point is that a beginner should not open HSK 1 to find
    // the app has already decided they know it.
    await resetApp(page);
    expect(await page.evaluate(() => window.__tangram.repo.getSettings())).toMatchObject({
      knownBand: 0,
    });
    await page.goto('/library');
    await page.locator('[data-list-name="HSK 1"]').getByRole('link', { name: 'Open' }).click();
    const members = page.getByTestId('list-member');
    await expect(members.first()).toBeVisible({ timeout: 60_000 });
    await expect(members.first()).toHaveAttribute('data-state', 'new');
  });

  test('a custom list can be created, filled by search, and queued from', async ({ page }) => {
    await resetApp(page);
    await page.goto('/library');
    await page.getByLabel('New list name').fill('Kitchen Chinese');
    await page.getByRole('button', { name: 'Create list' }).click();

    const mine = page.locator('[data-list-name="Kitchen Chinese"]');
    await expect(mine).toBeVisible();
    await expect(mine).toHaveAttribute('data-list-kind', 'custom');
    await mine.getByRole('link', { name: 'Open' }).click();

    await page.getByLabel('Find a word').fill('跑步');
    await page.getByRole('button', { name: 'Find' }).click();
    await expect(page.getByTestId('word-search-results')).toBeVisible({ timeout: 60_000 });
    // `exact`: the search now goes through P1's router in `DictStore`, which also
    // returns 跑步机 and 跑步者 — a substring match would be ambiguous.
    await page.getByRole('button', { name: 'Add 跑步', exact: true }).click();

    const member = page.getByTestId('list-member').first();
    await expect(member).toBeVisible();
    await expect(member).toHaveAttribute('data-state', 'new');

    // "Add to queue" is what puts a list word into the study loop.
    const queue = member.getByRole('button', { name: 'Add to queue: 跑步' });
    await queue.click();
    await expect(queue).toHaveText('Queued');
    await expect(queue).toBeDisabled();
    const cards = await page.evaluate(() => window.__tangram.repo.allCards());
    expect(cards).toHaveLength(1);
    expect(cards[0].context?.source).toBe('list');
    expect(cards[0].snapshot).toMatchObject({ simp: '跑步' });
  });

  test('a custom list can lose a word and then be deleted', async ({ page }) => {
    // `deleteList` / `removeListMembers` are the repository additions the merge
    // applied for HANDOFF-p3 "Needs 2": a custom list used to be permanent.
    await resetApp(page);
    await page.goto('/library');
    await page.getByLabel('New list name').fill('Kitchen Chinese');
    await page.getByRole('button', { name: 'Create list' }).click();
    await page.locator('[data-list-name="Kitchen Chinese"]').getByRole('link', { name: 'Open' }).click();

    await page.getByLabel('Find a word').fill('跑步');
    await page.getByRole('button', { name: 'Find' }).click();
    await expect(page.getByTestId('word-search-results')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Add 跑步', exact: true }).click();
    await expect(page.getByTestId('list-member')).toHaveCount(1);

    await page.getByRole('button', { name: 'Remove from list: 跑步' }).click();
    await expect(page.getByTestId('list-member')).toHaveCount(0);

    // Deleting is two clicks, and it lands back on /lists without the list.
    await page.getByTestId('delete-list').click();
    await page.getByTestId('confirm-delete-list').click();
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.locator('[data-list-name="Kitchen Chinese"]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('[data-list-name="Kitchen Chinese"]')).toHaveCount(0);
  });
});
