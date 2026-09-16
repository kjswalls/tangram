/**
 * `data.md` D6, acceptance criterion 3 — **the app works with the network
 * offline, from a cold start.**
 *
 * > The app runs with the network offline from a cold start, once the dictionary
 * > is `ready`: lookup, search, segmentation of a pasted passage and the
 * > character sheet all work.
 *
 * This is the whole point of the phase, and nothing asserted it. The nearest
 * things were `tests/e2e/c/sw-offline.spec.ts`, which proves the *shell* renders
 * offline and says nothing about the dictionary, and D4's
 * `tests/e2e/d/dict-wasm.spec.ts`, which proves a reload re-opens the artifact
 * out of OPFS with zero network bytes — but online, through the harness, with a
 * manifest the network was there to serve.
 *
 * "From a cold start" is the load-bearing half. A dictionary that answers until
 * the tab is closed and then cannot be opened again is not an offline
 * dictionary; it is a cache. So every case here **reloads** with the network
 * down before it asks the dictionary anything.
 *
 * It lives beside D4's suite because it is about the same store, and it is
 * separate from `c/sw-offline.spec.ts` because that one is `web.md`'s worker and
 * this one is `data.md`'s dictionary: they fail for different reasons and a
 * reader should not have to work out which.
 */
import { expect, test, type Page } from '@playwright/test';

/** The dictionary's first load is a 43 MB import; give it room. */
test.setTimeout(180_000);

const PASSAGE = '我打算明天去北京看望我的朋友。';

/** Load the app and wait for the dictionary to finish importing. */
async function warm(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__tangram), null, { timeout: 60_000 });
  await page.evaluate(() => window.__tangram.dict.open(), null);
  expect(await page.evaluate(() => window.__tangram.dict.status.state)).toBe('ready');
  // The service worker has to hold the shell, or the reload below fails on the
  // document rather than on the dictionary and the case proves nothing.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);
}

/**
 * Reload with the network down and open the dictionary again.
 *
 * `page.reload()` is what makes this a cold start: a new document, a new worker,
 * an empty `globalThis` memo — everything except the bytes already in OPFS.
 */
async function coldOffline(page: Page): Promise<void> {
  await page.context().setOffline(true);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__tangram), null, { timeout: 60_000 });
  await page.evaluate(() => window.__tangram.dict.open().catch(() => undefined), null);
}

test.describe('the dictionary with the network down', () => {
  test('opens from a cold start and answers every kind of query', async ({ page, context }) => {
    await warm(page);
    await coldOffline(page);

    try {
      const status = await page.evaluate(() => window.__tangram.dict.status);
      expect(
        status.state,
        `the dictionary did not open offline: ${JSON.stringify(status)}`,
      ).toBe('ready');

      // The four things criterion 3 names, in the order it names them.
      const answers = await page.evaluate(async (passage) => {
        const dict = window.__tangram.dict;
        const hanzi = await dict.search('打算');
        const gloss = await dict.search('plan');
        const segmented = await dict.segment(passage);
        const decomp = await window.__tangram.decomp.decompose('打');
        return {
          hanziFirst: hanzi.groups[0]?.simp ?? null,
          glossHas: gloss.groups.some((group) => group.simp === '计划'),
          words: segmented.tokens.filter((token) => token.kind === 'word').map((token) => token.text),
          decompChar: decomp[0]?.char ?? null,
          decompHasEntry: Boolean(decomp[0]?.entry),
        };
      }, PASSAGE);

      expect(answers.hanziFirst, 'hanzi lookup').toBe('打算');
      expect(answers.glossHas, 'English gloss search').toBe(true);
      expect(answers.words, 'segmentation of a pasted passage').toEqual(
        expect.arrayContaining(['我', '打算', '明天', '去', '北京']),
      );
      // The character sheet's data. `decomp.json` is a separate file under a
      // separate licence (PLAN.md §5) and a separate fetch, so it is a separate
      // assertion — it is the half of criterion 3 that is NOT in the artifact.
      expect(answers.decompChar, 'the character sheet').toBe('打');
      expect(answers.decompHasEntry, 'decomposition offline').toBe(true);
    } finally {
      await context.setOffline(false);
    }
  });

  test('re-opens without fetching the artifact again', async ({ page, context }) => {
    // The mechanism behind the case above, asserted separately so a failure says
    // which half broke: offline or re-download. D4 measured this online; the
    // claim here is that no request for the artifact is even attempted, because
    // offline every attempt would fail and the count would still read zero.
    await warm(page);

    const requested: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith('.sqlite') || path.endsWith('.sqlite.br')) requested.push(path);
    });

    await coldOffline(page);
    try {
      expect(await page.evaluate(() => window.__tangram.dict.status.state)).toBe('ready');
      expect(requested, 'the artifact was fetched again from OPFS-backed storage').toEqual([]);
    } finally {
      await context.setOffline(false);
    }
  });

  test('says so, rather than throwing, when there is no dictionary and no network', async ({
    page,
    context,
  }) => {
    // CLAUDE.md: *missing data is a banner, not a crash*. A first visit with no
    // network has nothing in OPFS and nothing to fetch, and the learner has to
    // be told — with the app still standing.
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.evaluate(() => navigator.serviceWorker.ready);
    // Wipe what the warm-up put in OPFS, so this really is a first visit.
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
        await root.removeEntry(name, { recursive: true }).catch(() => undefined);
      }
    });

    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.getByTestId('dict-gate')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('dict-status')).toBeVisible();
      // The shell is still there — Practice and Library are the learner's own
      // data and do not depend on any of this.
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
      await page.goto('/library');
      await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
      await expect(page.getByTestId('dict-gate')).toHaveCount(0);
    } finally {
      await context.setOffline(false);
    }
  });
});
