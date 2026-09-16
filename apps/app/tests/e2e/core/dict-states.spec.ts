/**
 * The four states the dictionary can be in (docs/plans/core.md C4a).
 *
 * `data.md` D1 freezes `DictStatus` as
 * `absent | preparing{received?,total?} | ready{version} | failed{reason,message}`,
 * and three sibling plans (`data.md` D4/D5a/D5b, `ios.md` I3, `android.md` A5)
 * each say this plan draws the screens. C1 put them in the gallery as literals;
 * what is asserted here is the thing a literal cannot show — that the gate
 * **re-renders from `store.subscribe()`**, that the determinate bar's value
 * *moves*, and that a retry reaches `open()`.
 *
 * The store behind the gallery section is `components/gallery/fake-dict-store.ts`
 * — the hand-written fake `core.md` §4 allows until `data.md` D4 gives the
 * browser a `SqlRunner`.
 */
import { expect, test, type Page } from '@playwright/test';

import { DASUAN, openReview, seed } from '../p2/fixtures';

async function openGallery(page: Page): Promise<void> {
  await page.goto('/gallery');
  await expect(page.getByTestId('dict-drive')).toBeVisible();
}

const gate = (page: Page) => page.getByTestId('dict-gate');
const bar = (page: Page) => page.getByTestId('dict-gate').getByTestId('dict-progress-bar');

test.describe('the dictionary gate, driven by a store', () => {
  test('absent offers to get it, and says how big it is', async ({ page }) => {
    await openGallery(page);
    await page.getByTestId('drive-absent').click();

    await expect(gate(page)).toHaveAttribute('data-state', 'absent');
    // A silent 14 MB download on a metered connection is a hostile default
    // (`data.md` measured the artifact; C4a says to state the size).
    await expect(gate(page).getByTestId('dict-status')).toContainText('MB');
    await expect(page.getByTestId('dict-gate-children')).toHaveCount(0);
  });

  test('preparing shows a DETERMINATE bar whose value moves', async ({ page }) => {
    await openGallery(page);
    await page.getByTestId('drive-preparing').click();

    await expect(gate(page)).toHaveAttribute('data-state', 'preparing');
    await expect(gate(page).getByTestId('dict-progress')).toHaveAttribute('data-determinate', 'true');

    const max = await bar(page).getAttribute('aria-valuemax');
    expect(Number(max)).toBeGreaterThan(0);
    expect(Number(await bar(page).getAttribute('aria-valuenow'))).toBe(0);

    // `data.md` D4 emits `received`/`total` "so core.md can show a determinate
    // bar", which makes an indeterminate spinner here a defect rather than a
    // simplification — and a bar that never moves the same defect one layer in.
    const seen: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await page.getByTestId('drive-advance').click();
      seen.push(Number(await bar(page).getAttribute('aria-valuenow')));
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(3);
    expect(seen[2]).toBeLessThanOrEqual(Number(max));
  });

  test('an indeterminate preparing omits the value rather than inventing one', async ({ page }) => {
    // The gallery's literal specimen: `preparing` with no `received`/`total`.
    await page.goto('/gallery');
    const indeterminate = page
      .getByTestId('dict-state-preparing-indeterminate')
      .getByTestId('dict-progress-bar');
    await expect(indeterminate).toBeVisible();
    await expect(indeterminate).not.toHaveAttribute('aria-valuenow', /.*/);
    await expect(
      page.getByTestId('dict-state-preparing-indeterminate').getByTestId('dict-progress'),
    ).toHaveAttribute('data-determinate', 'false');
  });

  test('ready is the state with no screen', async ({ page }) => {
    await openGallery(page);
    await page.getByTestId('drive-ready').click();

    await expect(gate(page)).toHaveCount(0);
    await expect(page.getByTestId('dict-gate-children')).toBeVisible();
  });

  for (const reason of ['download', 'import', 'storage', 'corrupt'] as const) {
    test(`failed:${reason} says something specific, and offers a retry`, async ({ page }) => {
      await openGallery(page);
      await page.getByTestId(`drive-failed-${reason}`).click();

      await expect(gate(page)).toHaveAttribute('data-state', 'failed');
      const status = gate(page).getByTestId('dict-status');
      await expect(status).toHaveAttribute('data-reason', reason);
      await expect(page.getByTestId('dict-gate-children')).toHaveCount(0);

      // Each reason offers a retry, because a retry is a re-download of the
      // same content-addressed file (C4a).
      const retry = status.getByTestId('dict-retry');
      await expect(retry).toBeVisible();
      await retry.click();
      // …and the retry reaches the store: `open()` moves it back to preparing.
      await expect(gate(page)).toHaveAttribute('data-state', 'preparing');
    });
  }

  test('the four failure reasons do not share one message', async ({ page }) => {
    await openGallery(page);
    const copy: string[] = [];
    for (const reason of ['download', 'import', 'storage', 'corrupt'] as const) {
      await page.getByTestId(`drive-failed-${reason}`).click();
      copy.push((await gate(page).getByTestId('dict-status').textContent()) ?? '');
    }
    // "Four distinguishable reasons... `storage` gets its own copy, because it
    // is the one the learner can act on." Four states with one sentence between
    // them would satisfy every other assertion in this file.
    expect(new Set(copy).size).toBe(4);
  });
});

/**
 * **The app keeps working without a dictionary** (`data.md` D4: "the app runs
 * without a dictionary; `core.md` must have that state drawn").
 *
 * Practice, lists and stats are the learner's own data in IndexedDB and have
 * nothing to do with CC-CEDICT; lookup and the reader are what degrade. This is
 * the half of C4a that is easiest to lose, because gating one route too many is
 * a one-line mistake that no other spec here would see.
 */
test.describe('with the dictionary down', () => {
  test.beforeEach(async ({ page }) => {
    // The manifest refuses, so the store lands in `failed`. Since `data.md` D6
    // this is the whole of "the dictionary is down": there is no route left to
    // refuse, and a manifest that will not load is a store that cannot open.
    await page.route('**/dict-manifest.json', (route) => route.fulfill({ status: 503, body: '' }));
  });

  test('a review still runs start to finish', async ({ page }) => {
    await openReview(page);
    await seed(page, [{ entry: DASUAN, gradedDaysAgo: 30 }]);

    await expect(page.getByTestId('review-card')).toBeVisible();
    await expect(page.getByTestId('dict-gate')).toHaveCount(0);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toBeVisible();
    await page.keyboard.press('3');

    await expect(page.getByTestId('review-empty')).toBeVisible();
    // `seed(gradedDaysAgo)` writes the prior review it implies, so what is
    // asserted is that THIS grade was recorded on top of it.
    const ratings = await page.evaluate(async () =>
      (await window.__tangram.db.reviews.toArray()).map((row) => row.rating),
    );
    expect(ratings).toHaveLength(2);
    expect(ratings.at(-1)).toBe(3);
  });

  test('a word can still be added to a list from the cards already there', async ({ page }) => {
    await openReview(page);
    await seed(page, [{ entry: DASUAN, gradedDaysAgo: 30 }]);

    const listId = await page.evaluate(async () => {
      const list = await window.__tangram.repo.createList({ name: 'Offline list', kind: 'custom' });
      await window.__tangram.repo.addListMembers(list.id, ['打算|打算[da3 suan4]']);
      return list.id;
    });

    await page.goto(`/library/lists/${listId}`);
    await expect(page.getByTestId('dict-gate')).toHaveCount(0);
    // The word is there. Its gloss and reading are not — those are the
    // dictionary's — and that is the whole shape of "degrades, not dies".
    await expect(page.getByTestId('list-member')).toHaveCount(1);
    await expect(page.getByTestId('list-member')).toContainText('打算');
  });

  /**
   * **The HSK band nobody has opened yet** — the one list shape whose membership
   * the dictionary derives rather than the learner owning it.
   *
   * `ensureMembers` fills an HSK list from `source.band()` on its first visit,
   * so on a fresh install all eight system lists take that path. The rejection
   * used to escape `readDetail` entirely: the page sat on "Loading words…"
   * under a raw `run pnpm data`, for ever, with no retry — while the custom-list
   * case above passed, because its members were already in IndexedDB and
   * `materialise` returns early before it can throw. One catch covered one of
   * the two calls that can reject.
   */
  test('an HSK band never opened before says so, instead of loading for ever', async ({ page }) => {
    await page.goto('/library');
    const hsk = page.getByTestId('list-card').filter({ hasText: 'HSK 3' }).first();
    await expect(hsk).toBeVisible();
    await hsk.getByRole('link', { name: /HSK 3/ }).click();

    // The page renders. The empty state is the dictionary's, not the learner's,
    // and it says which — a band that reads "This list has no words yet" is
    // telling the learner they emptied a list they have never opened.
    const empty = page.getByTestId('list-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toHaveAttribute('data-unfilled', 'true');
    await expect(empty).toContainText('dictionary');
    // …and no developer-facing hint is the page's headline.
    await expect(page.getByText('run pnpm data')).toHaveCount(0);
    await expect(page.getByText('Loading words…')).toHaveCount(0);
  });

  test('…and /lookup and /read are the two that DO gate', async ({ page }) => {
    for (const route of ['/', '/read']) {
      await page.goto(route);
      await expect(page.getByTestId('dict-gate'), route).toBeVisible();
      await expect(page.getByTestId('dict-gate'), route).toHaveAttribute('data-state', 'failed');
    }
  });
});