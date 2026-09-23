/**
 * **The ask**: what a fresh origin gets, what a returning learner gets, and
 * which entry points fetch nothing (`data.md` D6's one shipped defect, fixed).
 *
 * D6 pointed `browser-store.ts` at the OPFS store and left `<DictGate>`'s mount
 * calling `store.open()`. The line did not change; what it cost did — a probe
 * became a 43 MB download, started from a mount effect, with no ask, no
 * progress bar and no cancel. It was worse away from the gate than on it:
 * `lib/lists/entry-source.ts` and `components/review/example-sentences.tsx` sit
 * **outside** `<DictGate>` on purpose, because PLAN.md says the learner's own
 * data keeps working without a dictionary, so tapping **Library** on a fresh
 * install downloaded 14 MB on a screen with nowhere to say so.
 *
 * Every assertion here is about bytes rather than markup, because markup is
 * what the old behaviour also produced: the gate looked fine while the network
 * was doing something nobody asked for. `fetches()` counts the two requests
 * that make up a download — the manifest and the content-addressed artifact —
 * and a fresh origin must make **neither** until a learner presses a button.
 *
 * This is the file that would fail if the fix were reverted, and it is
 * deliberately not the file the rest of the suite leans on: `tests/e2e/dict.ts`
 * is the helper the other specs use, and it stands on this behaviour rather
 * than replacing it.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { MANIFEST_FILE, type DictManifest } from '../../../lib/dict/artifact';
import { workspaceRoot } from '../../../lib/server/roots';
import { installDictionary } from '../dict';
import { MA2, MA5, MA_SENTENCE, makeStaleArtifact } from './stale-artifact';

const DATA_DIR = process.env.TANGRAM_DATA_DIR
  ? resolve(workspaceRoot(), process.env.TANGRAM_DATA_DIR)
  : resolve(workspaceRoot(), 'data');
const manifest = JSON.parse(readFileSync(join(DATA_DIR, MANIFEST_FILE), 'utf8')) as DictManifest;

/** Several cases here download 43 MB before they assert anything. */
test.setTimeout(180_000);

/**
 * Record whether the ask is **ever** rendered in this page, however briefly.
 *
 * A `MutationObserver` installed before the first script runs, rather than a
 * poll: what these cases assert is that something never happened, and a poll
 * steps over a card that flashed. `data-state` is the wrong thing to watch —
 * it reads `absent` while the probe is still out, which is exactly when the
 * gate is deliberately drawing nothing. `dict-start` existing IS the ask.
 */
async function watchForTheAsk(page: Page): Promise<() => Promise<boolean>> {
  await page.addInitScript(() => {
    const w = window as Window & { __askSeen?: boolean };
    w.__askSeen = false;
    const look = () => {
      if (document.querySelector('[data-testid="dict-start"]')) w.__askSeen = true;
    };
    new MutationObserver(look).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    look();
  });
  return () =>
    page.evaluate(() => (window as Window & { __askSeen?: boolean }).__askSeen === true);
}

/**
 * Count every request that is part of getting the dictionary.
 *
 * `page.on('request')` rather than `page.route()`: routing would change what the
 * page is allowed to do, and what is being asserted is what it *chooses* to do.
 * Both halves are counted because either alone is a hole — the manifest is the
 * cheap one and skipping the artifact would still be the wrong default.
 */
function fetches(page: Page): { manifest: number; artifact: number; reset(): void } {
  const counts = { manifest: 0, artifact: 0, reset: () => {
    counts.manifest = 0;
    counts.artifact = 0;
  } };
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith(`/${MANIFEST_FILE}`)) counts.manifest += 1;
    if (url.pathname.endsWith(`/${manifest.file}`)) counts.artifact += 1;
  });
  return counts;
}

test.describe('a fresh origin', () => {
  test('is asked, with the size on it, and nothing is fetched until it answers', async ({ page }) => {
    const seen = fetches(page);
    await page.goto('/');

    const gate = page.getByTestId('dict-gate');
    await expect(gate).toHaveAttribute('data-state', 'absent');
    // The card `components/dict/dict-status.tsx` was drawn for: the size, and a
    // button. Before this branch it had no production path that reached it.
    await expect(gate.getByTestId('dict-status')).toContainText('MB');
    await expect(gate.getByTestId('dict-start')).toBeVisible();
    // …and the search box is withheld rather than offered and broken.
    await expect(page.getByTestId('lookup-input')).toHaveCount(0);

    // The whole point. A mount is not a download.
    expect(seen.artifact).toBe(0);
    expect(seen.manifest).toBe(0);
  });

  test('downloads when the ask is accepted, and draws the bar while it does', async ({ page }) => {
    const seen = fetches(page);
    await page.goto('/');

    const gate = page.getByTestId('dict-gate');
    await expect(gate.getByTestId('dict-start')).toBeVisible();
    await gate.getByTestId('dict-start').click();

    // `data.md` D4 emits `received`/`total` so this bar can be determinate;
    // the download the button starts is what it draws for.
    await expect(gate).toHaveAttribute('data-state', 'preparing');

    await expect(gate).toHaveCount(0, { timeout: 180_000 });
    await expect(page.getByTestId('lookup-input')).toBeVisible();

    expect(seen.manifest).toBeGreaterThan(0);
    expect(seen.artifact).toBe(1);
  });

  /**
   * **The sharper half.** Library, Practice and the reader index are not gated,
   * so a download started from one of them has nowhere on screen to appear.
   * `ListsView`'s mount effect fills an HSK list through `source.band(1)` →
   * `openDictStore()`, which is the exact path that used to fetch.
   */
  for (const route of ['/library', '/practice', '/read'] as const) {
    test(`${route} fetches nothing and is not gated`, async ({ page }) => {
      const seen = fetches(page);
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      // `/read` IS gated — it is a lookup surface — so it is the one route here
      // that shows the ask. What it must not do, gated or not, is fetch.
      if (route === '/read') {
        await expect(page.getByTestId('dict-gate')).toHaveAttribute('data-state', 'absent');
      } else {
        await expect(page.getByTestId('dict-gate')).toHaveCount(0);
      }

      // Give the mount effects room to have done the wrong thing.
      await page.waitForTimeout(1_500);
      expect(seen.artifact, route).toBe(0);
      expect(seen.manifest, route).toBe(0);
    });
  }

  test('an HSK band degrades rather than downloading behind the learner’s back', async ({ page }) => {
    const seen = fetches(page);
    await page.goto('/library');
    const hsk = page.getByTestId('list-card').filter({ hasText: 'HSK 3' }).first();
    await expect(hsk).toBeVisible();
    await hsk.getByRole('link', { name: /HSK 3/ }).click();

    // The same screen `tests/e2e/core/dict-states.spec.ts` asserts for a
    // dictionary that is down — because "not downloaded yet" and "down" are the
    // same thing to a surface that has no dictionary to read.
    const empty = page.getByTestId('list-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toHaveAttribute('data-unfilled', 'true');
    await expect(empty).toContainText('dictionary');

    expect(seen.artifact).toBe(0);
  });
});

test.describe('a learner who already has it', () => {
  test('gets it back with no gate and no second download, on a reload', async ({ page }) => {
    await installDictionary(page);

    const seen = fetches(page);
    const asked = await watchForTheAsk(page);
    await page.reload();

    // `ready` is the state with no screen. This is `smoke.spec.ts`'s "no gate
    // when the dictionary answers", against an origin that earned it.
    await expect(page.getByTestId('lookup-input')).toBeVisible();
    await expect(page.getByTestId('dict-gate')).toHaveCount(0);
    // …and the ask did not flash on the way. The gate holds the space silently
    // while the probe runs precisely so that it cannot.
    expect(await asked(), 'the reload showed the ask before opening what it had').toBe(false);

    // The artifact is content-addressed and already in OPFS: `openStored()`
    // finds it without going to the network for the bytes.
    expect(seen.artifact).toBe(0);
  });

  /**
   * **A stored dictionary that is an older build is replaced on the next load,
   * without asking again.**
   *
   * This is the path a real returning learner takes, and it is not the one
   * `d/dict-wasm.spec.ts`'s upgrade case drives: that harness calls the full
   * `open()`, while `<DictGate>` mounts with `openStored()`, which used to open
   * whatever the pool held without ever reading the manifest. A browser that had
   * the dictionary before a rebuild under the same filename kept it for good —
   * the learner who visited before the reading-order fix would still see 吗 as
   * má. Now the probe reads the manifest once it has found something stored,
   * rejects a stale file, and the gate's own escalation re-imports it, because
   * this origin has already said yes.
   *
   * The seed goes through the product's own ask, with the manifest standing in
   * for the old deploy's (no digest, so the file lands under the bare filename,
   * as it did for every browser before the fix) and the stale bytes served for
   * the artifact.
   */
  test('whose stored copy is an older build gets the new one on the next load, unasked', async ({
    page,
  }) => {
    const artifact = join(DATA_DIR, manifest.file);
    const stale = makeStaleArtifact(artifact, 'ask');
    const isArtifact = (url: URL) => url.pathname.endsWith(`/${manifest.file}`);
    await page.route(`**/${MANIFEST_FILE}`, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...manifest, bytes: stale.bytes, sha256: '' }),
      }),
    );
    await page.route(isArtifact, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/vnd.sqlite3' },
        path: stale.path,
      }),
    );
    await installDictionary(page);

    const firstOf吗 = () =>
      page.evaluate(async (sentence) => {
        const result = await window.__tangram.dict.segment(sentence);
        return result.tokens.at(-1)?.entryIds?.[0];
      }, MA_SENTENCE);
    expect(await firstOf吗(), 'the seed did not take: the stale file is not what opened').toBe(MA2);

    await page.unroute(`**/${MANIFEST_FILE}`);
    await page.unroute(isArtifact);

    // The deploy. Same filename, new bytes, and the learner just reloads.
    const seen = fetches(page);
    const artifactUrls: string[] = [];
    page.on('request', (request) => {
      if (isArtifact(new URL(request.url()))) artifactUrls.push(request.url());
    });
    const asked = await watchForTheAsk(page);
    await page.reload();
    await expect(page.getByTestId('lookup-input')).toBeVisible({ timeout: 180_000 });
    expect(await asked(), 'the learner was asked again for a dictionary they had').toBe(false);
    expect(await firstOf吗(), 'the browser kept the older build').toBe(MA5);
    expect(seen.artifact).toBe(1);
    expect(new URL(artifactUrls[0]).searchParams.get('sha256')).toBe(manifest.sha256);

    // …and the new build is what stays: the next reload downloads nothing.
    seen.reset();
    await page.reload();
    await expect(page.getByTestId('lookup-input')).toBeVisible();
    await expect(page.getByTestId('dict-gate')).toHaveCount(0);
    expect(await firstOf吗()).toBe(MA5);
    expect(seen.artifact).toBe(0);
  });

  /**
   * **A second tab is not asked again**, and it is the case the ask-once rule
   * exists for.
   *
   * `opfs-sahpool` takes an exclusive handle on each of its files **per
   * origin**, so a second tab cannot read the stored artifact at all — the
   * worker says so itself ("or — the common one — a second tab"). `data.md`
   * D4's ladder already answers that with the in-memory rung, which is why
   * `d/dict-wasm.spec.ts`'s "a second tab falls back to memory" exists; what
   * this asserts is that the *learner* is not dragged back into the ask for it.
   * So the assertion is about the ask, not about bytes: this tab does fetch,
   * because reading OPFS is the one thing it cannot do.
   */
  test('gets it back in a second tab, without being asked again', async ({ page, context }) => {
    await installDictionary(page);

    const second = await context.newPage();
    const askedIn = await watchForTheAsk(second);
    await second.goto('/');

    await expect(second.getByTestId('lookup-input')).toBeVisible({ timeout: 180_000 });
    expect(
      await askedIn(),
      'the second tab showed the ask for a dictionary this origin has',
    ).toBe(false);
    await second.close();
  });

  test('is not asked again on Library, and the glosses are there', async ({ page }) => {
    await installDictionary(page);

    const seen = fetches(page);
    await page.goto('/library');
    const hsk = page.getByTestId('list-card').filter({ hasText: 'HSK 3' }).first();
    await expect(hsk).toBeVisible();
    await hsk.getByRole('link', { name: /HSK 3/ }).click();

    // The ungated caller reads through `openStored()` too, so a returning
    // learner's list fills exactly as it did before the fix.
    await expect(page.getByTestId('list-member').first()).toBeVisible({ timeout: 60_000 });
    expect(seen.artifact).toBe(0);
  });
});
