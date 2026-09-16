/**
 * The Look up tab's three answer states (docs/plans/core.md C7;
 * product-decisions §5).
 *
 * The happy path already had a spec (`p4/ask.spec.ts`). These are the other
 * three, and C7 asks for them by name because they are what makes the grounding
 * promise *visible* rather than merely true:
 *
 *   1. **thinking** — the dictionary card is rendered and addable before the
 *      model returns. The answer never blocks the add.
 *   2. **unavailable** — a quiet chip, and everything else still works.
 *   3. **every proposal fails grounding** — and the dictionary answers in its
 *      own voice rather than leaving an empty panel behind, with the real words
 *      still addable from the dictionary card above.
 *
 * Each one is forced at the network boundary rather than through a test hook,
 * because the state the learner sees is a property of what came back over the
 * wire; a hook that sets the state directly would pass against a panel that
 * could never enter it.
 *
 * **Case 3 changed in `backend.md` B2, and the change is worth understanding
 * rather than working around.** It used to assert `ungrounded`, and it could,
 * because the substitution that prevents that state lived on the *other* side
 * of the wire: `app/api/ask` replaced a dead answer with a retrieval echo
 * (§3.4's "no query ever renders an empty panel"), and an intercepted response
 * bypassed the route and therefore the echo. After the contract flip the echo is
 * `lib/ai/ask-client.ts`'s, on the same side as the panel, so **nothing an
 * intercepted response can say reaches the panel un-echoed** — and `ungrounded`
 * is unreachable through the ask module.
 *
 * That is not a regression this phase introduced: it was already unreachable in
 * a real deployment, for exactly the same reason, and only a mock that skipped
 * the route could produce it. What B2 changed is that a mock cannot any more, so
 * the spec asserts what actually happens. The `ungrounded` *rendering* is still
 * covered — `core/gallery.spec.ts` draws it from C7's fixture and
 * `tests/unit/lookup/ask-state.test.ts` pins the mapping. Whether the panel
 * should key `ungrounded` off the echo instead is `core.md` C7's call, not this
 * phase's; recorded in HANDOFF.md.
 *
 * **The route patterns are regexes, not globs**, for a reason that bit this
 * phase: a glob on the parent path matches neither `/api/ask/propose` nor
 * `/api/ask/answer`, so one left over from before the flip is a spec that
 * intercepts nothing and passes for the wrong reason.
 */
import { expect, type Page, test } from '../dict';

import { ASK_OFFLINE_CHIP } from '@/components/lookup/ask-state';

import { expectBaseText } from '../hanzi';
import { resetApp } from '../p3/helpers';

/** 打算 — in every band of the dictionary, so the lookup half never flakes. */
const QUERY = '打算';

const panel = (page: Page) => page.getByTestId('ask-panel');

async function lookUp(page: Page, query: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('lookup-input').fill(query);
  await expect(page.getByTestId('search-result').first()).toBeVisible({ timeout: 20_000 });
}

/**
 * **This spec needs a dictionary on the device**, so it accepts the ask once
 * before each test — `tests/e2e/dict.ts`, which is also where the next person
 * to change this behaviour changes it. The default there is `'ask'`, a fresh
 * origin with nothing stored, because that is what a fresh origin really gets
 * now that `<DictGate>`'s mount probes instead of downloading.
 */
test.use({ dictionary: 'installed' });

test.describe('the Look up tab’s three answer states', () => {
  test.beforeEach(async ({ page }) => {
    // The spine would otherwise put ten HSK words in front of the one card
    // these specs add.
    await resetApp(page, { newPerDay: 0 });
  });

  test('thinking: the dictionary card is addable before the model returns', async ({ page }) => {
    // Hold the model call open for the whole test. Nothing releases it — the
    // point is that nothing on the dictionary side was ever waiting for it.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/api\/ask(\/|$)/, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await held;
      await route.abort();
    });

    await lookUp(page, QUERY);
    await page.getByTestId('search-result').first().click();
    await expect(page.getByTestId('entry-detail')).toBeVisible();

    // The answer is out and unfinished…
    await expect(panel(page)).toHaveAttribute('data-ask-state', 'thinking', { timeout: 20_000 });
    await expect(page.getByTestId('ask-ai-chip')).toBeVisible();

    // …and the card goes in anyway, while it is still pending.
    const add = page.getByTestId('add-card');
    await expect(add).toBeEnabled();
    await add.click();
    await expect(page.getByTestId('add-state')).toContainText('Added');
    expect(await cardCount(page)).toBe(1);

    // Still thinking: the add did not resolve, cancel or depend on the answer.
    await expect(panel(page)).toHaveAttribute('data-ask-state', 'thinking');
    release?.();
  });

  test('unavailable: a quiet chip, and the dictionary still answers', async ({ page }) => {
    await page.route(/\/api\/ask(\/|$)/, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.abort('internetdisconnected');
    });

    await lookUp(page, QUERY);
    // The dictionary half is untouched — that is the half of "everything else
    // works" a status-only assertion would miss.
    // Through `baseText`: C3's per-character ruby interleaves the readings into
    // `textContent`, so a plain `toContainText('打算')` reads `打dǎ算suàn`.
    await expectBaseText(page.getByTestId('search-result').first(), '打算');
    await page.getByTestId('search-result').first().click();
    await expect(page.getByTestId('entry-detail')).toBeVisible();

    await expect(panel(page)).toHaveAttribute('data-ask-state', 'unavailable', { timeout: 40_000 });
    await expect(page.getByTestId('ask-offline-chip')).toHaveText(ASK_OFFLINE_CHIP);

    // …and the add still works with no AI at all.
    await page.getByTestId('add-card').click();
    await expect(page.getByTestId('add-state')).toContainText('Added');
    expect(await cardCount(page)).toBe(1);
  });

  test('every proposal dropped: the dictionary answers, and the panel is never empty', async ({
    page,
  }) => {
    await page.route(/\/api\/ask\/answer$/, async (route) => {
      /**
       * **Every proposal fails grounding** — which is not the same as an empty
       * answer, and the difference is what this case is about.
       *
       * The body below *cites* two entries; neither id is in the retrieved set
       * this device built for 打算, so `ground()` drops both and the answer
       * collapses to nothing. §3.4's "no query ever renders an empty panel" is a
       * promise about what is on screen, so `ask-client` substitutes the
       * dictionary's own ranking (`retrievalEcho`) — and, because that answer is
       * the dictionary's rather than the model's, it is **not written to the
       * cache**, which the last assertion checks.
       */
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'fake',
          promptVersion: 'v1',
          response: {
            interpretation: '',
            matches: [
              { entryId: '沒有這個|没有这个[mei2 you3 zhe4 ge5]', senseIndex: 0, whyThisOne: 'invented' },
              { entryId: '也沒有|也没有[ye3 mei2 you3]', senseIndex: 1, whyThisOne: 'also invented' },
            ],
            sayIt: [],
            notes: [],
          },
        }),
      });
    });

    await lookUp(page, QUERY);
    await page.getByTestId('search-result').first().click();
    await expect(page.getByTestId('entry-detail')).toBeVisible();

    await expect(panel(page)).toHaveAttribute('data-ask-state', 'answered', { timeout: 20_000 });
    // The dictionary's voice, not the model's, and it says so.
    await expect(panel(page)).toContainText('Offline', { timeout: 20_000 });
    // Not one of the ids the model invented reached the screen.
    const drawn = (await panel(page).textContent()) ?? '';
    for (const invented of ['没有这个', '也没有']) expect(drawn).not.toContain(invented);

    // No phrase cards: the model proposed none that survived.
    expect(await page.getByTestId('ask-sayit-add').count()).toBe(0);

    // product-decisions §5: the real words are still addable. The dictionary
    // card is where they come from, and grounding rejecting an answer has no
    // say over it.
    await page.getByTestId('add-card').click();
    await expect(page.getByTestId('add-state')).toContainText('Added');
    expect(await cardCount(page)).toBe(1);

    // The echoed fallback is never cached: the next ask must reach the provider
    // again rather than repeat this for as long as the row lives.
    expect(await askCacheSize(page)).toBe(0);
  });
});

function cardCount(page: Page): Promise<number> {
  return page.evaluate(async () => (await window.__tangram.repo.allCards()).length);
}

function askCacheSize(page: Page): Promise<number> {
  return page.evaluate(async () => (await window.__tangram.db.ask_cache.toArray()).length);
}
