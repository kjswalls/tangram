import { expect, test, type Page } from '@playwright/test';

import { DEMO_PARAGRAPH } from './p5/paragraph';

/**
 * The post-merge integration spec (PLAN.md §4, "Phases 1–3").
 *
 * One walk of the loop the whole product is for, across all three merged
 * phases and touching no fixture: **look up 打算 → Add → Today shows 1 new →
 * /review shows 打算 → grade 3 → a `reviews` row exists → the nav reaches every
 * route.** Each phase's own suite proves its half in isolation; this is the one
 * spec that fails if the seams between them are wrong — the card P1 writes has
 * to be the card P3 counts and P2 offers, or nothing here passes.
 *
 * `newPerDay: 0` is deliberate: with the spine draw switched off, "1 new" is
 * exactly the word that was looked up, which is also the §3.3 rule that an
 * explicit Add is never subject to the daily cap.
 */

const DASUAN = '打算|打算[da3 suan4]';

const ROUTES = [
  { path: '/', label: 'Today', heading: 'Today' },
  { path: '/lookup', label: 'Lookup', heading: 'Lookup' },
  { path: '/review', label: 'Review', heading: 'Review' },
  { path: '/read', label: 'Read', heading: 'Read' },
  { path: '/lists', label: 'Lists', heading: 'Lists' },
  { path: '/settings', label: 'Settings', heading: 'Settings' },
] as const;

/** The layout mounts the test hook in an effect, so a fresh page waits for it. */
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => '__tangram' in window);
}

test('the loop: look up 打算, add it, meet it on Today, review it, grade it', async ({ page }) => {
  // A clean database, from the one route that neither draws cards nor
  // materialises a list, so the wipe cannot race the page it happens on.
  await page.goto('/settings');
  await ready(page);
  await page.evaluate(async () => {
    await window.__tangram.repo.resetAll();
    await window.__tangram.repo.setSettings({ newPerDay: 0 });
  });

  // --- look it up (P1) -----------------------------------------------------
  await page.goto('/lookup');
  await page.getByTestId('lookup-input').fill('dasuan');
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-query', 'dasuan');
  const first = page.getByTestId('search-result').first();
  await expect(first).toContainText('打算');
  await first.click();

  await expect(page.getByTestId('entry-detail')).toBeVisible();
  await page.getByTestId('add-card').click();
  await expect(page.getByTestId('add-state')).toContainText('Added');

  // The card exists, carries the query it came from, and names the dictionary
  // snapshot it was cut from — provenance is the product's second commitment.
  const saved = await page.evaluate(() => window.__tangram.repo.allCards());
  expect(saved).toHaveLength(1);
  expect(saved[0].entryId).toBe(DASUAN);
  expect(saved[0].context?.source).toBe('lookup');
  expect(saved[0].context?.query).toBe('dasuan');
  expect(saved[0].snapshot.dictVersion).toMatch(/\d/);

  // …and the Add joined the "Looked up" system list (P1 adding through P3's
  // `addCardTracked`, the seam the merge wired).
  const lookedUp = await page.evaluate(async () => {
    const repo = window.__tangram.repo;
    const list = (await repo.lists()).find((row) => row.kind === 'looked-up');
    return list ? (await repo.listMembers(list.id)).map((member) => member.entryId) : null;
  });
  expect(lookedUp).toContain(DASUAN);

  // --- Today counts it (P3) ------------------------------------------------
  await page.goto('/');
  await expect(page.getByTestId('today-new-count')).toHaveText('1');
  await expect(page.getByTestId('today-new-list')).toContainText('打算');

  // --- review it (P2) ------------------------------------------------------
  await page.getByTestId('start-review').click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByTestId('card-front')).toContainText('打算');

  await page.keyboard.press('Space');
  await expect(page.getByTestId('card-back')).toBeVisible();
  await expect(page.getByTestId('card-pinyin')).toHaveText('dǎsuàn');
  await page.keyboard.press('3');

  // The grade reached the database: one review row for this card, carrying the
  // rating and the pre-grade state, and the card is rescheduled forward.
  await expect(page.getByTestId('review-empty')).toBeVisible();
  const rows = await page.evaluate(() => window.__tangram.db.reviews.toArray());
  expect(rows).toHaveLength(1);
  expect(rows[0].cardId).toBe(saved[0].id);
  expect(rows[0].rating).toBe(3);
  expect(rows[0].before.state).toBe(0);

  const after = await page.evaluate(() => window.__tangram.repo.allCards());
  expect(after[0].fsrs.state).not.toBe(0);
  expect(after[0].due).toBeGreaterThan(Date.now());
});

test('the nav reaches every route with the card in place', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const route of ROUTES.slice(1)) {
    await nav.getByRole('link', { name: route.label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${route.path}$`));
    await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
  }
  await nav.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
});

/**
 * The full loop across all five phases (PLAN.md §4, "Phases 4–5").
 *
 * The spec above walks P1→P2→P3. This one walks the whole product, and it is
 * the only place the P4 and P5 seams are exercised *together*:
 *
 *   /settings Load demo → /lookup an English question → the ask panel answers
 *   from the seeded cache → Add the phrase it suggests → /read the demo
 *   paragraph → tap a word → Add it with its sentence → /review offers both
 *   new cards, the mined one with its sentence highlighted → grade → `reviews`
 *   rows exist for both → Today's counts have moved.
 *
 * Three merge seams fail this and nothing else: the demo's warm `ask_cache`
 * rows being keyed the way the panel keys them (`lib/ai/cache-key.ts`), the
 * phrase card the ask panel writes being a card `/review` can offer, and the
 * reader's sentence surviving all the way onto a card back.
 */

/** In the demo paragraph, in the sentence below — HSK 3, and not a demo card. */
const MINED = '附近';
const MINED_SENTENCE = '中午我和同事一起在公司附近的饭馆吃饭，下午继续工作。';
const BROWSING = "how do I say I'm just browsing";

interface Seen {
  front: string;
  context: string | null;
  target: string | null;
}

/**
 * Walk the session to the end, grading every card, and report what each card
 * showed. A graded card leaves the queue — with the learning steps on (Phase
 * 8's default) it comes back minutes later, which is longer than this walk
 * takes — so the queue always shortens; the bound is a guard against a
 * regression that makes it not, never a normal exit.
 */
async function walkSession(page: Page, rating: 1 | 2 | 3 | 4 = 3): Promise<Seen[]> {
  const seen: Seen[] = [];
  for (let step = 0; step < 40; step += 1) {
    if (await page.getByTestId('review-empty').isVisible().catch(() => false)) return seen;
    const card = page.getByTestId('review-card');
    await expect(card).toBeVisible();
    const id = await card.getAttribute('data-card-id');
    const front = ((await page.getByTestId('card-front').textContent()) ?? '').trim();

    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toBeVisible();
    const back = page.getByTestId('card-back');
    const line = back.getByTestId('context-back');
    const context = (await line.count()) > 0 ? await line.textContent() : null;
    const highlight = back.getByTestId('context-target');
    const target = (await highlight.count()) > 0 ? await highlight.textContent() : null;
    seen.push({ front, context, target });

    // The next card renders into the same element, so "graded" is the card id
    // changing — or the session emptying, which the top of the loop catches.
    await page.keyboard.press(String(rating));
    await expect
      .poll(
        async () => {
          const node = page.getByTestId('review-card');
          return (await node.count()) === 0 ? null : node.getAttribute('data-card-id');
        },
        { timeout: 15_000 },
      )
      .not.toBe(id);
  }
  throw new Error('the review session never emptied');
}

test('the whole product: demo → ask → phrase card → read → mine → review both → Today', async ({
  page,
}) => {
  // --- the demo state (P3) -------------------------------------------------
  await page.goto('/settings');
  await ready(page);
  await page.getByTestId('load-demo').click(); // arms the confirmation
  await page.getByTestId('load-demo').click(); // runs it
  await expect(page.getByTestId('settings-status')).toContainText('Demo', { timeout: 30_000 });

  // The spine is off for the rest of the walk: this spec is about the two cards
  // it mines by hand, not about the ten HSK words `/review` would draw.
  await page.evaluate(() => window.__tangram.repo.setSettings({ newPerDay: 0 }));

  // --- ask (P4) ------------------------------------------------------------
  await page.goto('/lookup');
  await page.getByTestId('lookup-input').fill(BROWSING);

  const ask = page.getByTestId('ask-panel');
  await expect(ask).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
  // The seed's warm row was found: the demo pre-warms `ask_cache` under the key
  // this panel derives in the browser, so the loop's first question costs no
  // provider call at all. A drift between the two derivations shows up here.
  await expect(ask).toHaveAttribute('data-cached', 'true');
  await expect(page.getByTestId('ask-offline-badge')).toBeVisible();

  const sayIt = page.getByTestId('ask-sayit').first();
  await expect(sayIt).toBeVisible();
  const phraseText = ((await sayIt.getByTestId('ask-token').allTextContents()) ?? []).length;
  expect(phraseText).toBeGreaterThan(0);

  await sayIt.getByTestId('ask-sayit-add').click();
  await expect(sayIt.getByTestId('ask-sayit-add')).toHaveText('Phrase added');

  const phraseCard = await page.evaluate(async () => {
    const rows = await window.__tangram.repo.allCards();
    const row = rows.find((card) => card.kind === 'phrase');
    return row
      ? {
          simp: (row.snapshot as { simp?: string }).simp ?? '',
          question: row.context?.question,
          sentence: row.context?.sentence,
          source: row.context?.source,
          offset: row.context?.offset,
        }
      : null;
  });
  expect(phraseCard).not.toBeNull();
  // The phrase card carries the question that produced it, and nothing else —
  // there was no sentence, so there is no span to point at either.
  expect(phraseCard?.question).toBe(BROWSING);
  expect(phraseCard?.source).toBe('ask');
  expect(phraseCard?.sentence).toBeUndefined();
  expect(phraseCard?.offset).toBeUndefined();
  const phraseFront = phraseCard?.simp ?? '';
  expect(phraseFront.length).toBeGreaterThan(1);

  // --- read and mine (P5) --------------------------------------------------
  await page.goto('/read');
  await ready(page);
  await page.getByTestId('reader-input').fill(DEMO_PARAGRAPH);
  await page.getByTestId('read-text').click();
  await expect(page.getByTestId('reader-text')).toBeVisible();

  const mined = page.locator(`[data-testid="reader-token"][data-token="${MINED}"]`).first();
  await expect(mined).toHaveAttribute('data-state', 'new');
  await mined.click();

  const panel = page.getByTestId('reader-panel');
  await expect(panel).toContainText(MINED_SENTENCE);
  // The reader's panel is the lookup panel, so P4's ask region is in it too,
  // asking about the tapped word *with the sentence as its context* — the
  // cross-phase seam this merge wired.
  await expect(panel.getByTestId('lookup-ask')).toBeVisible();
  await expect(panel.getByTestId('ask-panel')).toHaveAttribute('data-status', 'ready', {
    timeout: 30_000,
  });

  await panel.getByTestId('add-card').click();
  await expect(page.getByTestId('add-state')).toContainText('Added');
  // Adding made it a card, so the token behind the panel is `learning` now.
  await expect(mined).toHaveAttribute('data-state', 'learning');

  const minedCard = await page.evaluate(async (simp) => {
    const rows = await window.__tangram.repo.allCards();
    const row = rows.find((card) => (card.snapshot as { simp?: string }).simp === simp);
    return row ? { context: row.context, state: row.fsrs.state } : null;
  }, MINED);
  expect(minedCard?.context?.source).toBe('reader');
  expect(minedCard?.context?.sentence).toBe(MINED_SENTENCE);
  expect(minedCard?.state).toBe(0);
  const { sentence = '', offset, length } = minedCard?.context ?? {};
  expect(sentence.slice(offset ?? -1, (offset ?? 0) + (length ?? 0))).toBe(MINED);

  // --- review both of them (P2) -------------------------------------------
  await page.goto('/review');
  await ready(page);
  await expect(page.getByTestId('review-session')).toBeVisible({ timeout: 20_000 });

  const seen = await walkSession(page);
  const fronts = seen.map((card) => card.front);
  // Both mined cards were offered: the phrase the ask panel wrote and the word
  // the reader mined. The demo's own due cards came first; they are the reason
  // this walks the session rather than asserting on the first card.
  expect(fronts.some((front) => front.includes(phraseFront))).toBe(true);
  expect(fronts.some((front) => front.includes(MINED))).toBe(true);

  // …and the reader card's back showed the sentence, with the word highlighted.
  const minedSeen = seen.find((card) => card.front.includes(MINED));
  expect(minedSeen?.context).toBe(MINED_SENTENCE);
  expect(minedSeen?.target).toBe(MINED);

  // --- the grades reached the database (P2) --------------------------------
  const graded = await page.evaluate(async (simp) => {
    const rows = await window.__tangram.repo.allCards();
    const reviews = await window.__tangram.db.reviews.toArray();
    const byId = new Map(rows.map((card) => [card.id, card]));
    const forCard = (match: (card: (typeof rows)[number]) => boolean) =>
      reviews.filter((review) => {
        const card = byId.get(review.cardId);
        return card ? match(card) : false;
      }).length;
    return {
      total: reviews.length,
      phrase: forCard((card) => card.kind === 'phrase'),
      mined: forCard((card) => (card.snapshot as { simp?: string }).simp === simp),
      stillNew: rows.filter((card) => card.fsrs.state === 0).length,
    };
  }, MINED);
  expect(graded.phrase).toBeGreaterThan(0);
  expect(graded.mined).toBeGreaterThan(0);
  expect(graded.total).toBeGreaterThanOrEqual(seen.length);
  expect(graded.stillNew).toBe(0);

  // --- Today has moved (P3) ------------------------------------------------
  await page.goto('/');
  await ready(page);
  // Everything on offer was graded and rescheduled forward, and the spine is
  // off, so there is nothing left for today.
  await expect(page.getByTestId('today-due-count')).toHaveText('0');
  await expect(page.getByTestId('today-new-count')).toHaveText('0');
  await expect(page.getByTestId('start-review').getByRole('button')).toBeDisabled();
});
