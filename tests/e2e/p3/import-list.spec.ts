/**
 * The list importer on `/lists` and on a list's own page: paste, preview, write.
 */
import { expect, test } from '@playwright/test';

import { ready, resetApp } from './helpers';

test.describe('import a list', () => {
  test('three pasted lines — one polyphone, one non-word — become a list of two', async ({ page }) => {
    await resetApp(page);
    await page.goto('/lists');
    await ready(page);

    await page.getByTestId('import-open').click();
    await page.getByLabel('Words to import').fill('你好\n了\nxyzzyq\n');
    await page.getByLabel('Imported list name').fill('Pasted');
    await page.getByTestId('import-preview').click();

    const rows = page.getByTestId('import-row');
    await expect(rows).toHaveCount(3, { timeout: 60_000 });
    await expect(rows.nth(0)).toHaveAttribute('data-status', 'add');
    await expect(rows.nth(1)).toHaveAttribute('data-status', 'add');
    await expect(rows.nth(2)).toHaveAttribute('data-status', 'unmatched');

    // 了 is a polyphone: a picker, defaulting to the most frequent reading (le).
    const picker = page.getByLabel('Reading for 了');
    await expect(picker).toBeVisible();
    await expect(picker).toHaveValue('了|le');
    expect(await picker.locator('option').count()).toBeGreaterThan(1);
    // The non-word has no picker and is named as unmatched in the summary.
    await expect(page.getByLabel('Reading for xyzzyq')).toHaveCount(0);
    await expect(page.getByTestId('import-summary')).toContainText('1 not in the dictionary');

    const submit = page.getByTestId('import-submit');
    await expect(submit).toHaveText('Import 2 words');
    await submit.click();
    await expect(page.getByTestId('import-result')).toContainText('Added 2 words to Pasted');

    // One list, two members, and the reading that was picked.
    const lists = await page.evaluate(() => window.__tangram.repo.lists());
    const pasted = lists.find((list) => list.name === 'Pasted');
    expect(pasted).toMatchObject({ kind: 'custom', owner: 'user' });
    const members = await page.evaluate(
      (id) => window.__tangram.repo.listMembers(id),
      pasted?.id as string,
    );
    expect(members.map((member) => member.entryId).sort()).toEqual(
      ['了|了[le5]', '你好|你好[ni3 hao3]'].sort(),
    );

    // And the page agrees: the card counts two, the detail page lists two.
    const card = page.locator('[data-list-name="Pasted"]');
    await expect(card.getByTestId('list-count')).toHaveText('2');
    await card.getByRole('link', { name: 'Open' }).click();
    await expect(page.getByTestId('list-member')).toHaveCount(2);
  });

  test('a list’s own page imports into that list and skips what it already has', async ({ page }) => {
    await resetApp(page);
    await page.goto('/lists');
    await page.getByLabel('New list name').fill('Kitchen Chinese');
    await page.getByRole('button', { name: 'Create list' }).click();
    await page.locator('[data-list-name="Kitchen Chinese"]').getByRole('link', { name: 'Open' }).click();

    // A Pleco-shaped paste: the reading column picks liǎo over le.
    await page.getByLabel('Words to import').fill('了\tliǎo\tto finish\n跑步\tpǎobù\tto run\n');
    await page.getByTestId('import-preview').click();
    await expect(page.getByTestId('import-row')).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId('import-summary')).toContainText('Pleco');
    await expect(page.getByLabel('Reading for 了')).toHaveValue('了|liao3');
    await page.getByTestId('import-submit').click();
    await expect(page.getByTestId('import-result')).toContainText('Added 2 words');
    await expect(page.getByTestId('list-member')).toHaveCount(2);

    // Paste again with one repeat: only the new word is written.
    await page.getByLabel('Words to import').fill('跑步\n谢谢');
    await page.getByTestId('import-preview').click();
    await expect(page.getByTestId('import-row')).toHaveCount(2);
    await expect(page.getByTestId('import-row').nth(0)).toHaveAttribute('data-status', 'present');
    await expect(page.getByTestId('import-submit')).toHaveText('Import 1 word into Kitchen Chinese');
    await page.getByTestId('import-submit').click();
    await expect(page.getByTestId('import-result')).toContainText('skipped 1 already there');
    await expect(page.getByTestId('list-member')).toHaveCount(3);
  });
});
