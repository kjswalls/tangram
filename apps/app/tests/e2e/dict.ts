/**
 * The dictionary's ask, for the specs that are not about it.
 *
 * **Why this file exists.** Until this branch, `<DictGate>`'s mount called
 * `store.open()`, which since `data.md` D6 meant *download 43 MB* — silently,
 * with no ask, no progress and no cancel, and from `lib/lists/entry-source.ts`
 * as well, which is not even behind a gate. Every spec here that wanted a
 * working lookup box, reader, ask panel or card back got one because the bytes
 * arrived unbidden within a second on a container with a loopback network.
 * That was the defect, not the design: a fresh origin is now shown the `absent`
 * card and downloads nothing until someone presses **Get it**.
 *
 * **So the default below is the truth.** `test` from this module is
 * `@playwright/test`'s, plus one option that starts out `'ask'` — a fresh
 * origin, no dictionary, the card. A spec that needs a dictionary says so:
 *
 * ```ts
 * import { expect, test } from '../dict';
 * test.use({ dictionary: 'installed' });
 * ```
 *
 * …and gets a page that has already been through the ask, once, before the test
 * body runs. One `test.use` per file rather than a call at the top of every
 * test, and one place — `installDictionary` below — where the next person who
 * changes this behaviour changes it.
 *
 * **The trap this is written around.** A helper that quietly downloaded for
 * every test would make the suite green and put the defect straight back,
 * because nothing would then exercise the ask. Two things stop that. The
 * default is `'ask'`, so a spec that never opted in is running against a fresh
 * origin and would notice a gate that had crept back. And
 * `installDictionary()` **asserts the ask is there** before pressing it, so
 * even the opted-in specs would fail if the gate started downloading on its own
 * again — the helper cannot paper over a regression it is standing on.
 *
 * **What it does change, and a spec that opts in should know.** The install is
 * a real navigation to `/`, and it happens during fixture setup — *before* the
 * spec's own `beforeEach`, and therefore before any `page.route`,
 * `addInitScript`, `setOffline` or `resetApp` in the body. A spec whose subject
 * is the very first load of the app (a stubbed manifest, an init script that has
 * to beat the first render) must **not** opt in; it uses the default and calls
 * `installDictionary()` itself where it wants the ask answered. The three specs
 * that are about the dictionary do exactly that.
 *
 * `tests/e2e/d/dict-ask.spec.ts` is the spec that owns the behaviour itself:
 * what a fresh origin gets, what a returning learner gets, and which entry
 * points fetch nothing.
 */
import { test as base, expect, type Page } from '@playwright/test';

/**
 * Everything else `@playwright/test` exports — `Locator`, `devices`, the types
 * a spec annotates a helper with — so importing from here is a drop-in swap for
 * importing from there. The local `test` below shadows the star-exported one,
 * which is the whole point of the module.
 */
export * from '@playwright/test';

/**
 * The route the ask is drawn on. `/` — Look up — is the gated surface every
 * opted-in spec can reach regardless of what it is actually about.
 */
const GATED_ROUTE = '/';

/**
 * 43 MB over the preview server's loopback, plus the OPFS import. Generous
 * because a timeout here is an infrastructure failure reported as a product
 * one, and the happy path does not spend it — an install is a second or two on
 * this container.
 *
 * It is only spendable if the *test's* budget allows it: `playwright.config.ts`
 * sets no `timeout`, so the per-test default is 30 s and fixture time counts
 * against it. The fixture below raises its test's budget by this much. A spec
 * calling `installDictionary()` directly does not get that raise, deliberately
 * — a helper should not quietly change the budget of a test that did not ask
 * for it — so such a test fails on its own 30 s with the install named in the
 * trace, which is the diagnosis either way.
 */
const INSTALL_TIMEOUT_MS = 120_000;

/**
 * Accept the dictionary's ask, once, and wait until it is installed.
 *
 * Asserting `dict-start` before clicking it is the point: this helper is the
 * suite's only witness that a fresh origin *asks*, repeated across every spec
 * that uses it. A gate that downloaded on mount again would not have a button
 * here, and every opted-in file would fail rather than silently passing on the
 * old behaviour.
 *
 * The artifact lands in OPFS, which is per browser context and therefore per
 * test, so this runs once per test and every later navigation in that test
 * finds the dictionary already there.
 */
export async function installDictionary(page: Page): Promise<void> {
  await page.goto(GATED_ROUTE);

  const gate = page.getByTestId('dict-gate');
  const start = gate.getByTestId('dict-start');
  await expect(gate).toHaveAttribute('data-state', 'absent');
  await expect(start).toBeVisible();

  await start.click();
  // `ready` is the state with no screen, so the gate going away is the whole
  // assertion — and it is the same one a learner makes.
  await expect(gate).toHaveCount(0, { timeout: INSTALL_TIMEOUT_MS });
}

export type DictionaryMode = 'ask' | 'installed';

export const test = base.extend<{ dictionary: DictionaryMode }>({
  dictionary: ['ask', { option: true }],
  // `run`, not Playwright's usual `use`: the shared eslint config has React's
  // rules-of-hooks on, and a parameter called `use` inside a function called
  // `page` reads to it as a hook call in a non-component.
  page: async ({ page, dictionary }, run, testInfo) => {
    if (dictionary === 'installed') {
      // The install is this fixture's cost, not the test's. Without the raise a
      // slow container turns "the download took 31 s" into "your test timed
      // out", which is a product failure reported for an infrastructure one.
      testInfo.setTimeout(testInfo.timeout + INSTALL_TIMEOUT_MS);
      await installDictionary(page);
    }
    await run(page);
  },
});

