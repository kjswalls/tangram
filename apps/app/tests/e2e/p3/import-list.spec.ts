/**
 * The list importer, end to end: paste, preview, pick a reading, write.
 *
 * Ported from `main`'s `abe6793` (`wave-zero.md` §8a), rehomed from `/lists` to
 * the Library tab that `core.md` C7 folded it into, and rewired from
 * `abe6793`'s dictionary-resolve route — which no longer exists, and whose
 * whole `/api/**` prefix the app's own origin now 404s — to
 * `DictStore.resolve` in the browser.
 *
 * What it is here to catch is the loop, not the parsing: the parsers have 311
 * lines of unit tests and the plan has its own, but only this can say that a
 * paste in the box ends as rows in IndexedDB under the reading the learner
 * chose.
 */
import { expect, test } from '../dict';

import { ready, resetApp } from './helpers';

/**
 * **This spec needs a dictionary on the device.** Resolution is the whole
 * subject, so it accepts the ask once before each test — `tests/e2e/dict.ts`,
 * whose default is a fresh origin with nothing stored.
 */
test.use({ dictionary: 'installed' });

test.describe('import a list', () => {
  test('three pasted lines — one polyphone, one non-word — become a list of two', async ({
    page,
  }) => {
    await resetApp(page);
    await page.goto('/library');
    await ready(page);

    await page.getByTestId('import-open').click();
    await page.getByLabel('Words to import').fill('你好\n了\nxyzzyq\n');
    await page.getByLabel('Imported list name').fill('Pasted');
    await page.getByTestId('import-preview').click();

    const rows = page.getByTestId('import-row');
    await expect(rows).toHaveCount(3, { timeout: 60_000 });
    await expect(rows.nth(0)).toHaveAttribute('data-status', 'add');
    await expect(rows.nth(1)).toHaveAttribute('data-status', 'add');
    // The line the dictionary does not have is **reported**, not dropped.
    await expect(rows.nth(2)).toHaveAttribute('data-status', 'unmatched');

    // 了 is a polyphone: a picker, defaulting to the most frequent reading (le).
    const picker = page.getByLabel('Reading for 了');
    await expect(picker).toBeVisible();
    await expect(picker).toHaveValue('了|了|le');
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

  test('a list’s own page imports into that list and skips what it already has', async ({
    page,
  }) => {
    await resetApp(page);
    await page.goto('/library');
    await ready(page);
    await page.getByLabel('New list name').fill('Kitchen Chinese');
    await page.getByRole('button', { name: 'Create list' }).click();
    await page
      .locator('[data-list-name="Kitchen Chinese"]')
      .getByRole('link', { name: 'Open' })
      .click();

    // A Pleco-shaped paste: the reading column picks liǎo over le.
    await page.getByLabel('Words to import').fill('了\tliǎo\tto finish\n跑步\tpǎobù\tto run\n');
    await page.getByTestId('import-preview').click();
    await expect(page.getByTestId('import-row')).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId('import-summary')).toContainText('Pleco');
    await expect(page.getByLabel('Reading for 了')).toHaveValue('了|了|liao3');
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

  /**
   * The mixed paste the acceptance criteria name, in one go: simplified,
   * traditional, tone-marked pinyin, numbered pinyin, toneless pinyin, and a
   * line the dictionary does not have.
   *
   * This is the case the resolution rule exists for, and the one that would
   * survive a `search`-shaped implementation looking almost right: 打 resolves
   * to 打 and must not become 打算.
   */
  test('a mixed paste resolves each line by its own spelling', async ({ page }) => {
    await resetApp(page);
    await page.goto('/library');
    await ready(page);

    await page.getByTestId('import-open').click();
    await page
      .getByLabel('Words to import')
      .fill('学习\n學習\ndǎsuàn\nni3hao3\nnihao\n打\nxyzzyq\n');
    await page.getByLabel('Imported list name').fill('Mixed');
    await page.getByTestId('import-preview').click();

    const rows = page.getByTestId('import-row');
    await expect(rows).toHaveCount(7, { timeout: 60_000 });
    // 学习 and 學習 are the same word in two scripts, so the second is a
    // duplicate of the first rather than a second member.
    await expect(rows.nth(0)).toHaveAttribute('data-status', 'add');
    await expect(rows.nth(1)).toHaveAttribute('data-status', 'duplicate');
    await expect(rows.nth(6)).toHaveAttribute('data-status', 'unmatched');
    await expect(page.getByTestId('import-summary')).toContainText('1 not in the dictionary');

    await page.getByTestId('import-submit').click();
    await expect(page.getByTestId('import-result')).toContainText('Added');

    const lists = await page.evaluate(() => window.__tangram.repo.lists());
    const mixed = lists.find((list) => list.name === 'Mixed');
    const members = await page.evaluate(
      (id) => window.__tangram.repo.listMembers(id),
      mixed?.id as string,
    );
    const ids = members.map((member) => member.entryId);
    expect(ids).toContain('學習|学习[xue2 xi2]');
    expect(ids).toContain('打算|打算[da3 suan4]');
    expect(ids).toContain('你好|你好[ni3 hao3]');
    // 打 is its own word. A prefix match would have made it 打算, which is
    // already in this list from `dǎsuàn` — so the assertion is that the 打 row
    // contributed a 打 entry of its own.
    expect(ids.some((id) => id.startsWith('打|打['))).toBe(true);
  });

  /**
   * Missing data is a banner, not a crash (CLAUDE.md), and Library says it
   * **once** — `d/dict-missing-surface.spec.ts` is the standing guard for all
   * three tabs, and this is the importer's half of it: the box is still there,
   * pressing Preview does not break the page, and the card with the button is
   * the only thing that mentions the dictionary.
   *
   * No `dictionary: 'installed'` override, so this test runs on the fixture's
   * default — a fresh origin with nothing stored.
   */
  test.describe('with no dictionary on the device', () => {
    test.use({ dictionary: 'ask' });

    test('the importer is quiet and Library still says it once', async ({ page }) => {
      await page.goto('/library');
      await expect(page.getByTestId('screen-library')).toBeVisible();
      await expect(page.getByTestId('dict-status')).toHaveCount(1);

      await page.getByTestId('import-open').click();
      await page.getByLabel('Words to import').fill('你好\n了\n');
      await page.getByTestId('import-preview').click();

      // Nothing to preview, nothing added, and no second surface: the card with
      // the button above is still the only place the dictionary is mentioned.
      await expect(page.getByTestId('import-preview')).toBeEnabled();
      await expect(page.getByTestId('import-row')).toHaveCount(0);
      await expect(page.getByTestId('import-error')).toHaveCount(0);
      await expect(page.getByTestId('dict-status')).toHaveCount(1);

      // And the raw `Error.message` reached no part of the screen.
      const body = (await page.locator('body').innerText()).toLowerCase();
      expect(body).not.toContain('not on this device yet');

      // The paste survives, so pressing Get it and trying again is the whole
      // recovery — the learner does not retype the list.
      await expect(page.getByLabel('Words to import')).toHaveValue('你好\n了\n');
      await expect(page.getByTestId('lists')).toBeVisible();
    });
  });
});
