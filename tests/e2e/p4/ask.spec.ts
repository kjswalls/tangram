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
    expect(saved[0].context?.question).toBe('看');

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
    // One phrase card plus one word card per cited entry in the phrase.
    expect(afterWords.filter((card) => card.kind === 'word')).toHaveLength(3);
    expect(afterWords.map((card) => card.simp)).toEqual(
      expect.arrayContaining(['我随便看看', '我', '随便', '看看']),
    );
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
