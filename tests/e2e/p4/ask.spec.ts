/**
 * Phase 4 — the grounded ask panel (PLAN.md §3.4, §4 P4).
 *
 * Every line of the P4 acceptance row that names a route is here: the demo
 * query renders surviving matches and a sayIt, an Add from a match makes a card
 * whose review back leads with the chosen sense, an Add from a sayIt makes a
 * phrase card, the offline badge shows while the fake is answering, and a
 * repeat question with the same context is served from `ask_cache` while a
 * different context is a different question.
 */
import { expect, type Page, test } from '@playwright/test';

import { resetApp } from '../p3/helpers';

const BROWSING = "how do I say I'm just browsing";
/** 看, fourth tone: `glosses[5]` is "to look after" — a sense that is not the first. */
const KAN4 = '看|看[kan4]';
const KAN4_SENSE = 5;

/** The panel is on the lookup page; typing is all it takes to ask. */
async function ask(page: Page, query: string): Promise<void> {
  await page.goto('/lookup');
  await page.getByTestId('lookup-input').fill(query);
  await expect(page.getByTestId('ask-panel')).toHaveAttribute('data-status', 'ready', {
    timeout: 20_000,
  });
}

/**
 * The cache key, computed the way the browser computes it (§3.4:
 * sha1(promptVersion, provider, query, context, estimatedBand)). A fresh
 * database means `estimatedBand` is `settings.knownBand`, which is 2.
 */
async function cacheKey(page: Page, query: string, context = ''): Promise<string> {
  return page.evaluate(
    async ({ query: q, context: ctx }) => {
      const payload = JSON.stringify(['v1', 'fake', q, ctx, 2]);
      const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(payload));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    },
    { query, context },
  );
}

async function cards(page: Page) {
  return page.evaluate(async () => {
    const rows = await window.__tangram.repo.allCards();
    return rows.map((card) => ({
      kind: card.kind,
      entryId: card.entryId,
      senseIndex: card.senseIndex,
      note: card.note,
      context: card.context,
      simp: 'simp' in card.snapshot ? card.snapshot.simp : '',
      glosses: 'glosses' in card.snapshot ? card.snapshot.glosses : [],
    }));
  });
}

async function askCacheRows(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await window.__tangram.db.ask_cache.toArray()).map((row) => row.id));
}

test.describe('the ask panel', () => {
  // The spine would otherwise put ten HSK words in front of the one card the
  // spec adds (HANDOFF.md, "For P4 and P5").
  test.beforeEach(async ({ page }) => {
    await resetApp(page, { newPerDay: 0 });
  });

  test('the demo query renders surviving matches, a sayIt, and the offline badge', async ({
    page,
  }) => {
    await ask(page, BROWSING);

    const panel = page.getByTestId('ask-panel');
    await expect(panel).toHaveAttribute('data-provider', 'fake');
    await expect(page.getByTestId('ask-offline-badge')).toBeVisible();
    await expect(page.getByTestId('ask-offline-badge')).toContainText('ANTHROPIC_API_KEY');

    await expect(page.getByTestId('ask-interpretation')).not.toBeEmpty();
    expect(await page.getByTestId('ask-match').count()).toBeGreaterThanOrEqual(1);
    expect(await page.getByTestId('ask-sayit').count()).toBeGreaterThanOrEqual(1);

    // The phrase is rendered from cited entries: real hanzi, real pinyin, and
    // nothing flagged, because 我随便看看 is three ordinary words.
    const first = page.getByTestId('ask-sayit').first();
    await expect(first).toHaveAttribute('data-unverified', 'false');
    await expect(first).toContainText('随便');
    await expect(first).toContainText('suíbiàn');

    // The dictionary body is untouched by any of it (§3.4).
    await expect(page.getByTestId('lookup-panel')).toBeVisible();
  });

  test('Add from a match makes a card whose review back leads with the chosen sense', async ({
    page,
  }) => {
    // A pre-warmed cache row is the cleanest way to pin a sense that is *not*
    // the first one — and it exercises the other half of §3.4 at the same time:
    // the row holds ids and indexes only, so everything on screen has to be
    // re-resolved against the dictionary.
    const key = await cacheKey(page, '看');
    await page.evaluate(
      async ({ key: id, entryId, senseIndex }) => {
        await window.__tangram.repo.askCache.set(id, {
          interpretation: 'Here the verb is about minding someone rather than looking at them.',
          matches: [
            { entryId, senseIndex, whyThisOne: 'The sentence is about watching over a child.' },
          ],
          sayIt: [],
          notes: [],
        });
      },
      { key, entryId: KAN4, senseIndex: KAN4_SENSE },
    );

    await ask(page, '看');
    await expect(page.getByTestId('ask-panel')).toHaveAttribute('data-cached', 'true');

    const match = page.getByTestId('ask-match').first();
    await expect(match).toHaveAttribute('data-entry-id', KAN4);
    await expect(match).toHaveAttribute('data-sense-index', String(KAN4_SENSE));
    // Rendered from the dictionary, not from the cache row.
    await expect(match).toContainText('kàn');
    await expect(match.getByTestId('ask-match-sense')).toContainText('to look after');

    await match.getByTestId('ask-match-add').click();
    await expect(match.getByTestId('ask-match-state')).toContainText('Added');

    const saved = await cards(page);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ kind: 'word', entryId: KAN4, senseIndex: KAN4_SENSE });
    expect(saved[0].context?.source).toBe('ask');
    // The "question" was the headword itself, so none is recorded: a card back
    // that quotes its own front is not provenance (the review's minor fix).
    expect(saved[0].context?.question).toBeUndefined();

    await page.goto('/review');
    await expect(page.getByTestId('review-card')).toBeVisible();
    await page.keyboard.press('Space');
    const glosses = page.getByTestId('card-glosses').locator('li');
    await expect(glosses.first()).toHaveText('to look after');
    // The others are still there, folded away behind "other senses".
    await expect(page.getByTestId('card-back')).toContainText('to see');
  });

  test('Add from a sayIt makes a phrase card, and the words can be added one by one', async ({
    page,
  }) => {
    await ask(page, BROWSING);

    const phrase = page.getByTestId('ask-sayit').first();
    await phrase.getByTestId('ask-sayit-add').click();
    await expect(phrase.getByTestId('ask-sayit-add')).toContainText('Phrase added');

    const afterPhrase = await cards(page);
    expect(afterPhrase).toHaveLength(1);
    expect(afterPhrase[0].kind).toBe('phrase');
    expect(afterPhrase[0].simp).toBe('我随便看看');
    expect(afterPhrase[0].context?.source).toBe('ask');
    expect(afterPhrase[0].context?.question).toBe(BROWSING);

    await phrase.getByTestId('ask-sayit-add-words').click();
    await expect(phrase.getByTestId('ask-sayit-add-words')).toContainText('Words added');

    const afterWords = await cards(page);
    // One card for the one word the learner does not already know. 我 (HSK 1)
    // and 随便 (HSK 2) are inside `knownBand`, and queueing a word the app
    // itself paints as known — and lists as "known · Queued" — is the app
    // arguing with the learner.
    expect(afterWords.filter((card) => card.kind === 'word').map((card) => card.simp)).toEqual([
      '看看',
    ]);
    await expect(phrase.getByTestId('ask-sayit-words-state')).toContainText('1 added');
    await expect(phrase.getByTestId('ask-sayit-words-state')).toContainText('already known');
  });

  test('the same phrase added twice is one card, and says so before it is pressed', async ({
    page,
  }) => {
    await ask(page, BROWSING);
    const phrase = page.getByTestId('ask-sayit').first();
    await phrase.getByTestId('ask-sayit-add').click();
    await expect(phrase.getByTestId('ask-sayit-add')).toContainText('Phrase added');

    // A reload is what made this a duplicate: the button's disabled state is
    // per-mount, and `addPhraseCard` itself had no idempotency at all.
    await ask(page, BROWSING);
    const again = page.getByTestId('ask-sayit').first();
    await expect(again.getByTestId('ask-sayit-add')).toContainText('Already in your cards');
    await expect(again.getByTestId('ask-sayit-add')).toBeDisabled();
    expect((await cards(page)).filter((card) => card.kind === 'phrase')).toHaveLength(1);
  });

  test('a phrase carrying the model’s own characters cannot become a card', async ({ page }) => {
    // A `{text}` token is the model's invention. The review card renders
    // `snapshot.simp` — the joined tokens, with no flag on them — at 6xl, and
    // its pinyin line is built from the *dictionary* tokens only, so the back
    // would read a syllable short. Nothing on the review path knows about
    // `unverified`, so the Add is the place to stop it.
    const key = await cacheKey(page, 'zzz unverified');
    await page.evaluate(async (id) => {
      await window.__tangram.repo.askCache.set(id, {
        interpretation: 'A made-up compound, for the flag.',
        matches: [],
        sayIt: [
          {
            tokens: [{ entryId: '我|我[wo3]' }, { text: '隨便' }, { entryId: '看看|看看[kan4 kan5]' }],
            en: 'I am just looking',
            register: 'invented',
          },
        ],
        notes: [],
      });
    }, key);

    await ask(page, 'zzz unverified');
    const phrase = page.getByTestId('ask-sayit').first();
    await expect(phrase).toHaveAttribute('data-unverified', 'true');
    await expect(phrase.getByTestId('ask-sayit-add')).toBeDisabled();
    await expect(phrase.getByTestId('ask-sayit-add')).toContainText('cannot add');
    await expect(phrase.getByTestId('ask-sayit-warning')).toContainText('cannot become a card');

    // The cited words are still one tap away — that is the offer instead.
    await phrase.getByTestId('ask-sayit-add-words').click();
    await expect(phrase.getByTestId('ask-sayit-words-state')).toBeVisible();
    expect((await cards(page)).filter((card) => card.kind === 'phrase')).toHaveLength(0);
  });

  test('the answer is on screen on a phone, and it answers what was typed', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ask(page, BROWSING);

    // An English sentence has no headword to pick, so a panel gated on a
    // selection left a phone with "No matches" and nothing else — the front
    // door of §1 unreachable at 390px.
    await expect(page.getByTestId('ask-panel')).toBeVisible();
    await expect(page.getByTestId('ask-sayit').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
      true,
    );
  });

  test('picking a result keeps the answer to what was typed', async ({ page }) => {
    await ask(page, 'dasuan');
    const before = await page.getByTestId('ask-interpretation').textContent();
    expect(await page.getByTestId('ask-sayit').count()).toBeGreaterThanOrEqual(1);

    await page.getByTestId('search-result').first().click();
    await expect(page.getByTestId('entry-detail')).toBeVisible();
    // The panel header follows the pick; the ask does not. Re-asking with the
    // headword is a second provider call *and* throws away the answer being
    // read — under the fake it fell straight through to the offline echo.
    await expect(page.getByTestId('lookup-panel').locator('h2').first()).toContainText('打算');
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId('ask-panel')).toHaveAttribute('data-status', 'ready');
    expect(await page.getByTestId('ask-interpretation').textContent()).toBe(before);
    expect(await page.getByTestId('ask-sayit').count()).toBeGreaterThanOrEqual(1);
  });

  test('an answer to the previous word is never shown under the new one', async ({ page }) => {
    await ask(page, BROWSING);
    await expect(page.getByTestId('ask-sayit-add').first()).toBeVisible();

    // Inside the debounce the panel used to keep the previous answer — its
    // matches, its phrases and its Add buttons — under the new heading. An Add
    // pressed there wrote a card whose provenance named a different word.
    await page.getByTestId('lookup-input').fill('每天');
    await expect(page.getByTestId('ask-panel')).toHaveAttribute('data-status', 'loading');
    await expect(page.getByTestId('ask-status')).toContainText('每天');
    expect(await page.getByTestId('ask-sayit-add').count()).toBe(0);
    expect(await page.getByTestId('ask-match-add').count()).toBe(0);

    await expect(page.getByTestId('ask-panel')).toHaveAttribute('data-status', 'ready', {
      timeout: 20_000,
    });
  });

  test('a repeat question with the same context hits the cache; a different context does not', async ({
    page,
  }) => {
    let posts = 0;
    await page.route('**/api/ask', async (route) => {
      if (route.request().method() === 'POST') posts += 1;
      await route.continue();
    });

    await ask(page, BROWSING);
    await expect(page.getByTestId('ask-panel')).toHaveAttribute('data-cached', 'false');
    expect(posts).toBe(1);

    const key = await cacheKey(page, BROWSING);
    expect(await askCacheRows(page)).toEqual([key]);

    // Same question, same (absent) context: answered from IndexedDB.
    await ask(page, BROWSING);
    await expect(page.getByTestId('ask-panel')).toHaveAttribute('data-cached', 'true');
    expect(posts).toBe(1);
    expect(await askCacheRows(page)).toEqual([key]);

    // The same question about a sentence is a different question, and the row
    // that answered the first one cannot answer it.
    const withContext = await cacheKey(page, BROWSING, '我随便看看');
    expect(withContext).not.toBe(key);
    const hit = await page.evaluate(
      async (id) => (await window.__tangram.repo.askCache.get(id)) !== undefined,
      withContext,
    );
    expect(hit).toBe(false);
  });
});
