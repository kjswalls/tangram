/**
 * The full loop, Phase 6 item 5 (PLAN.md §4: "look up → add → review → read →
 * add-from-text → ask → add phrase"), walked end to end with **both** Phase 6
 * card features switched on.
 *
 * `tests/e2e/integration.spec.ts` already walks P1–P5. This spec is the one the
 * Phase 7 merge exists for: it is the only place where the three parallel
 * branches meet on one card back, in a browser, in the order a learner meets
 * them.
 *
 *   /settings Load demo + free recall + production direction on → /lookup an
 *   English sentence → the ask panel → Add the phrase → /read the demo
 *   paragraph → tap a word → Add it with its sentence → /review: the reader
 *   card shows its sentence highlighted, the phrase card is drawn per token,
 *   the recall box takes an answer and suggests a grade the learner overrides,
 *   the back carries the i+1 sentences (or the honest empty state) *and* the
 *   "add the reverse" control, which is pressed — so the same word comes back
 *   the other way round, meaning on the front and the hanzi to be written →
 *   grade both directions → / has moved → /stats says it has too little to go
 *   on, and then, over a seeded history, says the numbers.
 *
 * What fails here and in no single branch's suite:
 *
 *  - **A (examples) and B (recall) share `ReviewSession` and one `<ReviewCard>`.**
 *    Both slots are filled on the same card here, and the recall box's request
 *    and the examples fetch run against each other rather than alone.
 *  - **C's `lib/db` changes carry A's and B's readers.** The phrase card is
 *    written through the ask panel (`addPhraseCard`'s new fourth argument) and
 *    then reviewed; the mined card is introduced through `introduceCard`.
 *  - **The suggestion never becomes a grade** even when it lands on a card that
 *    is also fetching sentences. The row records the key that was pressed.
 *
 * Phase 8 added three more crossings, and they are why this spec grew:
 *
 *  - **One session holds both directions of one word** (Phase 8 B) and both
 *    Phase 6 features. The reverse is made from the back of the card the
 *    learner just answered, inside the session, and the queue picks it up with
 *    no reload — which is Phase 8 A's re-read doing its job.
 *  - **Two schedules, no coordination.** Grading the production card must not
 *    move the recognition card it was cut from; that is asserted here against a
 *    due date read before and after.
 *  - **`/stats` reads what this walk wrote** (Phase 8 C). A dozen reviews is
 *    below every rate floor on the page, so the honest empty state is the
 *    correct answer and is asserted first; the numbers are then made to appear
 *    by seeding a history, which also proves the panels are reading the log
 *    rather than a fixture.
 */
import { expect, test, type Page } from '@playwright/test';

import { ready, resetApp } from './p3/helpers';
import { DEMO_PARAGRAPH } from './p5/paragraph';

/** In the demo paragraph, in the sentence below — HSK 3, and not a demo card. */
const MINED = '附近';
const MINED_SENTENCE = '中午我和同事一起在公司附近的饭馆吃饭，下午继续工作。';
/** The demo seed pre-warms `ask_cache` for this question. */
const BROWSING = "how do I say I'm just browsing";
/** What the learner types into the recall box for 附近. */
const RECALL_ANSWER = 'nearby, close by';
/** …and what they write when the same word is asked the other way round. */
const PRODUCTION_ANSWER = MINED;

const DAY = 86_400_000;

/** The full walk is a demo load, a build, two adds and a whole session. */
test.setTimeout(300_000);

interface Cards {
  phraseId: string;
  phraseSimp: string;
  phraseDictVersion: string;
  minedId: string;
}

/**
 * A synthetic review history, written straight through the repository.
 *
 * `/stats` reports *rates*, and a rate wants trials: the demo seed plus this
 * walk's own handful of grades are below every floor on the page by design.
 * Rather than grade three hundred cards through the UI, the history is written
 * the way builder C's own spec writes it — twenty-four cards graduated by an Easy
 * from New (a learning review, which the retention denominator excludes) and
 * then answered Good on five days apart.
 */
async function seedHistory(page: Page): Promise<void> {
  await page.evaluate(
    async ({ days, cards, day }) => {
      const { repo } = window.__tangram;
      const now = Date.now();
      for (let index = 0; index < cards; index += 1) {
        const card = await repo.addPhraseCard(
          [{ text: `stat${index}`, entryId: `stat${index}|stat${index}[x]` }],
          `the ${index} one`,
          { source: 'seed', addedAt: now - 70 * day },
        );
        await repo.grade(card.id, 4, now - 60 * day);
        for (const ago of days) await repo.grade(card.id, 3, now - ago * day);
      }
    },
    { days: [45, 25, 18, 11, 4], cards: 24, day: DAY },
  );
}

/**
 * Grade the card on screen and wait for the session to move. The next card
 * renders into the same element, so "graded" is the card id changing — or the
 * session emptying, which the caller's loop catches.
 */
async function gradeAndAdvance(page: Page, id: string | null, key: string): Promise<void> {
  await page.keyboard.press(key);
  await expect
    .poll(
      async () => {
        const node = page.getByTestId('review-card');
        return (await node.count()) === 0 ? null : node.getAttribute('data-card-id');
      },
      { timeout: 30_000 },
    )
    .not.toBe(id);
}

test('the whole loop with i+1 sentences and free recall on', async ({ page }) => {
  // --- the demo learner, and both Phase 6 toggles --------------------------
  await resetApp(page);
  await page.getByTestId('load-demo').click(); // arms the confirmation
  await page.getByTestId('load-demo').click(); // runs it
  await expect(page.getByTestId('settings-status')).toContainText('Demo', { timeout: 120_000 });

  // Free recall is off by default and is thrown the way a person throws it.
  // The write is async and the checkbox is controlled, so the row is what we
  // wait on: /review reads the setting, not the DOM.
  const freeRecall = page.getByTestId('settings-free-recall');
  await expect(freeRecall).not.toBeChecked();
  await freeRecall.click();
  await expect(freeRecall).toBeChecked();
  // The i+1 block is on by default; assert it rather than set it, because
  // "undefined means on" is the contract a legacy settings row relies on.
  await expect(page.getByTestId('settings-examples-on-back')).toBeChecked();

  // Phase 8's second direction, thrown the same way. The setting only *reveals*
  // the controls that make production cards — it creates nothing, which is
  // checked below once the demo's cards are on the table.
  const production = page.getByTestId('settings-production-direction');
  await expect(production).not.toBeChecked();
  await production.click();
  await expect(production).toBeChecked();

  await page.waitForFunction(async () => {
    const settings = await window.__tangram.repo.getSettings();
    return (
      settings.freeRecall === true &&
      (settings.examplesOnBack ?? true) === true &&
      settings.productionDirection === true
    );
  });
  // Turning it on made no card: every row the demo left is a recognition card.
  expect(
    await page.evaluate(async () =>
      (await window.__tangram.repo.allCards()).filter((card) => card.direction === 'production')
        .length,
    ),
  ).toBe(0);

  // The spine draw is off for the rest of the walk: this spec is about the two
  // cards it adds by hand and the demo's own due cards, not about the ten HSK
  // words `/review` would otherwise introduce on top of them.
  await page.evaluate(() => window.__tangram.repo.setSettings({ newPerDay: 0 }));

  // --- ask an English sentence, and add the phrase (P4) --------------------
  await page.goto('/lookup');
  await page.getByTestId('lookup-input').fill(BROWSING);
  const ask = page.getByTestId('ask-panel');
  await expect(ask).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await expect(ask).toHaveAttribute('data-cached', 'true');

  const sayIt = page.getByTestId('ask-sayit').first();
  await expect(sayIt).toBeVisible();
  await sayIt.getByTestId('ask-sayit-add').click();
  await expect(sayIt.getByTestId('ask-sayit-add')).toHaveText('Phrase added');

  // --- read the paragraph and mine a word with its sentence (P5) -----------
  await page.goto('/read');
  await ready(page);
  await page.getByTestId('reader-input').fill(DEMO_PARAGRAPH);
  await page.getByTestId('read-text').click();
  await expect(page.getByTestId('reader-text')).toBeVisible();

  const token = page.locator(`[data-testid="reader-token"][data-token="${MINED}"]`).first();
  await expect(token).toHaveAttribute('data-state', 'new');
  await token.click();
  await expect(page.getByTestId('reader-panel')).toContainText(MINED_SENTENCE);
  await page.getByTestId('reader-panel').getByTestId('add-card').click();
  await expect(page.getByTestId('add-state')).toContainText('Added');
  await expect(token).toHaveAttribute('data-state', 'learning');

  const cards: Cards = await page.evaluate(async (simp) => {
    const rows = await window.__tangram.repo.allCards();
    const phrase = rows.find((card) => card.kind === 'phrase');
    const mined = rows.find(
      (card) => card.kind === 'word' && (card.snapshot as { simp?: string }).simp === simp,
    );
    if (!phrase || !mined) throw new Error('the two mined cards are not both in the database');
    return {
      phraseId: phrase.id,
      phraseSimp: (phrase.snapshot as { simp?: string }).simp ?? '',
      phraseDictVersion: phrase.snapshot.dictVersion,
      minedId: mined.id,
    };
  }, MINED);

  expect(cards.phraseSimp.length).toBeGreaterThan(1);
  // Builder C's item 2, through the path a learner takes rather than a unit
  // call: a phrase card records the dictionary it was cut from.
  expect(cards.phraseDictVersion).not.toBe('unknown');
  expect(cards.phraseDictVersion).toMatch(/\d/);

  const minedContext = await page.evaluate(async (id) => {
    const row = (await window.__tangram.repo.allCards()).find((card) => card.id === id);
    return row?.context ?? null;
  }, cards.minedId);
  expect(minedContext?.source).toBe('reader');
  expect(minedContext?.sentence).toBe(MINED_SENTENCE);

  // --- Today counts them both (P3) -----------------------------------------
  await page.goto('/');
  await ready(page);
  await expect(page.getByTestId('today-new-count')).not.toHaveText('—', { timeout: 60_000 });
  const before = await page.evaluate(() => ({
    due: Number(document.querySelector('[data-testid="today-due-count"]')?.textContent ?? '0'),
    fresh: Number(document.querySelector('[data-testid="today-new-count"]')?.textContent ?? '0'),
  }));
  // The two adds are never subject to the daily cap (§3.3), so they are on the
  // day's plate even with `newPerDay: 0`, and the demo left cards due.
  expect(before.fresh).toBeGreaterThanOrEqual(2);
  expect(before.due).toBeGreaterThanOrEqual(1);

  // --- the session, with both card features live ---------------------------
  await page.getByTestId('start-review').click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByTestId('review-session')).toBeVisible({ timeout: 60_000 });

  let sawPhrase = false;
  let sawMined = false;
  let sawProduction = false;
  let suggested = 0;
  let pressed = 0;
  /** The reverse of the mined card, made from its back part-way through. */
  let productionId: string | null = null;
  /** The mined card's schedule after it was graded — the twin must not move it. */
  let minedAfterGrade: { due: number; reps: number } | null = null;

  for (let step = 0; step < 40; step += 1) {
    if (await page.getByTestId('review-empty').isVisible().catch(() => false)) break;
    const card = page.getByTestId('review-card');
    await expect(card).toBeVisible();
    const id = await card.getAttribute('data-card-id');

    if (id === cards.phraseId) {
      sawPhrase = true;
      // Builder C's item 1: the front is drawn one token at a time, and every
      // token of a phrase the ask panel accepted cites a dictionary row.
      const face = page.getByTestId('phrase-face');
      await expect(face).toHaveAttribute('data-tokens', 'true');
      await expect(face).toHaveAttribute('data-unverified', 'false');
      await expect(page.getByTestId('phrase-face-warning')).toHaveCount(0);
      const parts = page.getByTestId('phrase-face-token');
      expect(await parts.count()).toBeGreaterThan(1);
      for (const value of await parts.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-entry-id') ?? ''),
      )) {
        expect(value).not.toBe('');
      }
      // A phrase has no entry, so there is nothing to recall against and
      // nothing to build a sentence about: neither block is on this card.
      await expect(page.getByTestId('card-recall')).toHaveCount(0);

      await page.keyboard.press('Space');
      await expect(page.getByTestId('card-back')).toBeVisible();
      await expect(page.getByTestId('card-en')).not.toBeEmpty();
      await expect(page.getByTestId('example-sentences')).toHaveCount(0);
      await gradeAndAdvance(page, id, '3');
      continue;
    }

    if (id === cards.minedId) {
      sawMined = true;
      // Free recall: the box is on the front, before the answer is up.
      await expect(page.getByTestId('card-recall')).toBeVisible();
      await expect(page.getByTestId('card-back')).toHaveCount(0);
      const rowsBefore = await page.evaluate(() => window.__tangram.db.reviews.count());

      await page.getByTestId('recall-answer').fill(RECALL_ANSWER);
      await page.getByTestId('recall-answer').press('Enter');

      // The flip waited for nobody — not for the grader, not for the sentences.
      await expect(page.getByTestId('card-back')).toBeVisible();
      const back = page.getByTestId('card-back');

      // The reader's sentence came all the way through, with the word marked.
      await expect(back.getByTestId('context-back')).toContainText(MINED_SENTENCE);
      await expect(back.getByTestId('context-target')).toHaveText(MINED);

      // The suggestion arrives, rings one button, and writes nothing.
      const suggestion = page.getByTestId('recall-suggestion');
      await expect(suggestion).toBeVisible({ timeout: 60_000 });
      suggested = Number(await suggestion.getAttribute('data-suggested'));
      expect([1, 2, 3, 4]).toContain(suggested);
      await expect(page.getByTestId(`grade-${suggested}`)).toHaveAttribute(
        'data-suggested',
        'true',
      );
      await expect(page.getByTestId('recall-answer')).toHaveValue(RECALL_ANSWER);
      expect(await page.evaluate(() => window.__tangram.db.reviews.count())).toBe(rowsBefore);

      // The suggestion says who made it: offline here, and badged as such.
      await expect(page.getByTestId('recall-offline')).toBeVisible();
      await expect(page.getByTestId(`grade-${suggested}`)).toContainText('suggested');

      // The i+1 block, on the same back, at the same time: sentences built from
      // words this learner knows, or the honest line saying there are not
      // enough of them yet. Both are answers; a spinner that never settles and
      // an error banner are not.
      const examples = page.getByTestId('example-sentences');
      await expect(examples).toHaveAttribute('data-status', 'ready', { timeout: 90_000 });
      const list = page.getByTestId('examples-list');
      const empty = page.getByTestId('examples-empty');
      expect((await list.count()) + (await empty.count())).toBe(1);
      if ((await list.count()) === 1) {
        const cited = await page
          .getByTestId('example-token')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-entry-id') ?? ''));
        expect(cited.length).toBeGreaterThan(0);
        // Every token on the back cites a dictionary row — the filter's promise,
        // seen from the browser.
        for (const value of cited) expect(value).not.toBe('');
        const targetId = await page.evaluate(async (cardId) => {
          const row = (await window.__tangram.repo.allCards()).find((item) => item.id === cardId);
          return row?.entryId ?? '';
        }, cards.minedId);
        // By entry id, and by the app's own rule for "known" — a declared row,
        // a card that has matured, or a band the learner assumed past with no
        // card on the word. A check on characters passes for a reading of a
        // known headword that the learner has never met.
        const verdicts = await page.evaluate(async (ids: string[]) => {
          const repo = window.__tangram.repo;
          const [known, allCards, settings] = await Promise.all([
            repo.knownEntryIds(),
            repo.allCards(),
            repo.getSettings(),
          ]);
          const declared = new Set(known);
          const byEntry = new Map(
            allCards.filter((row) => row.entryId).map((row) => [row.entryId as string, row]),
          );
          const query = ids.map((id) => `ids=${encodeURIComponent(id)}`).join('&');
          const bands = new Map<string, number | undefined>(
            (
              (await (await fetch(`/api/dict/entries?${query}`)).json()).entries as {
                id: string;
                hskBand?: number;
              }[]
            ).map((entry) => [entry.id, entry.hskBand]),
          );
          return ids.map((id) => {
            if (declared.has(id)) return 'known';
            const row = byEntry.get(id);
            if (row) return row.fsrs.state === 2 && row.fsrs.stability >= 21 ? 'known' : 'learning';
            const band = bands.get(id);
            return band !== undefined && band <= settings.knownBand ? 'known' : 'new';
          });
        }, cited);
        for (const [index, value] of cited.entries()) {
          if (value === targetId) continue;
          expect(verdicts[index], `${value} is on the back of the card`).toBe('known');
        }
      }

      // Phase 8: the reverse is offered on this same back, under the answer —
      // which is where the learner has just found out whether they could have
      // written the word rather than only recognised it. One press, one card,
      // and no charge against the daily allowance (§3.3's rule for an explicit
      // add). The session picks it up on the next re-read, with no reload.
      const addReverse = page.getByTestId('add-reverse-button');
      await expect(addReverse).toBeEnabled();
      await addReverse.click();
      await expect(page.getByTestId('add-reverse')).toHaveAttribute('data-phase', 'present');

      productionId = await page.evaluate(async (recognitionId) => {
        const rows = await window.__tangram.repo.allCards();
        const recognition = rows.find((card) => card.id === recognitionId);
        const twin = rows.find(
          (card) => card.direction === 'production' && card.entryId === recognition?.entryId,
        );
        if (!twin) throw new Error('add the reverse wrote no production card');
        // One word, two cards, two schedules.
        if (twin.wordId !== recognition?.wordId) throw new Error('the twin is a different word');
        return twin.id;
      }, cards.minedId);

      // The learner disagrees with the suggestion, and the learner wins.
      pressed = suggested === 2 ? 3 : 2;
      await gradeAndAdvance(page, id, String(pressed));
      minedAfterGrade = await page.evaluate(async (cardId) => {
        const row = (await window.__tangram.repo.allCards()).find((card) => card.id === cardId);
        if (!row) throw new Error('the mined card vanished');
        return { due: row.due, reps: row.fsrs.reps };
      }, cards.minedId);
      continue;
    }

    if (productionId !== null && id === productionId) {
      sawProduction = true;
      // The same word, asked the other way round: the meaning is the question
      // and the hanzi is the answer, so nothing on the front may give it away —
      // not the glosses, not the reading, and not the sentence it was mined
      // from, which is blanked where the word stood.
      const front = page.getByTestId('card-front');
      await expect(front).toBeVisible();
      await expect(front).not.toContainText(MINED);
      await expect(page.getByTestId('card-back')).toHaveCount(0);

      // An exact answer is settled in the browser. Any request is a failure of
      // that promise, so the route is made to fail if it is reached at all.
      let asked = 0;
      await page.route('**/api/recall', (route) => {
        asked += 1;
        return route.fulfill({ status: 500, body: '{}' });
      });

      await page.getByTestId('recall-answer').fill(PRODUCTION_ANSWER);
      await page.getByTestId('recall-answer').press('Enter');

      await expect(page.getByTestId('card-back')).toBeVisible();
      await expect(page.getByTestId('production-answer')).toHaveText(MINED);
      await expect(page.getByTestId('recall-suggestion')).toHaveAttribute('data-suggested', '3');
      expect(asked).toBe(0);
      await page.unroute('**/api/recall');

      await gradeAndAdvance(page, id, '3');
      continue;
    }

    // Every other card is one of the demo's: flipped without answering, which
    // closes the recall box rather than letting a grade be typed off the back.
    // The reveal button, not Space: with free recall on, the box has the
    // keyboard (a space belongs to the answer being typed), so "Show answer" is
    // the way past it that does not go through the box.
    await page.getByTestId('reveal').click();
    await expect(page.getByTestId('card-back')).toBeVisible();
    await expect(page.getByTestId('recall-missed')).toBeVisible();
    await gradeAndAdvance(page, id, '3');
  }

  expect(sawPhrase).toBe(true);
  expect(sawMined).toBe(true);
  // The reverse was made mid-session and the queue found it with no reload:
  // Phase 8 A's re-read carrying Phase 8 B's card.
  expect(sawProduction).toBe(true);
  await expect(page.getByTestId('review-empty')).toBeVisible();

  // Two directions, two memories: grading the twin left the card it was cut
  // from exactly where its own grade had put it.
  const minedNow = await page.evaluate(async (cardId) => {
    const row = (await window.__tangram.repo.allCards()).find((card) => card.id === cardId);
    if (!row) throw new Error('the mined card vanished');
    return { due: row.due, reps: row.fsrs.reps };
  }, cards.minedId);
  expect(minedNow).toEqual(minedAfterGrade);

  // --- what reached the database -------------------------------------------
  const graded = await page.evaluate(async (ids) => {
    const reviews = await window.__tangram.db.reviews.orderBy('reviewedAt').toArray();
    return {
      total: reviews.length,
      phrase: reviews.filter((row) => row.cardId === ids.phraseId).map((row) => row.rating),
      mined: reviews.filter((row) => row.cardId === ids.minedId).map((row) => row.rating),
      stillNew: (await window.__tangram.repo.allCards()).filter((card) => card.fsrs.state === 0)
        .length,
    };
  }, cards);

  expect(graded.phrase).toEqual([3]);
  // The one assertion the whole feature is for: the grade the learner pressed,
  // and never the one that was suggested.
  expect(graded.mined).toEqual([pressed]);
  expect(graded.mined).not.toContain(suggested);
  expect(graded.stillNew).toBe(0);

  // --- Today has moved (P3), and counts the two directions apart (Phase 8 B)
  await page.goto('/');
  await ready(page);
  await expect(page.getByTestId('today-due-count')).toHaveText('0');
  await expect(page.getByTestId('today-new-count')).toHaveText('0');
  await expect(page.getByTestId('start-review').getByRole('button')).toBeDisabled();
  // The split line counts *today's plate*, and the walk emptied it — so the
  // correct thing for it to do here is not appear. What is durable is the row:
  // one production card, its own schedule, its own review.
  await expect(page.getByTestId('today-direction-split')).toHaveCount(0);
  const twin = await page.evaluate(async (id) => {
    const rows = await window.__tangram.repo.allCards();
    const card = rows.find((row) => row.id === id);
    const reviews = await window.__tangram.db.reviews.where('cardId').equals(id).toArray();
    return {
      production: rows.filter((row) => row.direction === 'production').length,
      state: card?.fsrs.state ?? -1,
      ratings: reviews.map((row) => row.rating),
    };
  }, productionId!);
  expect(twin.production).toBe(1);
  expect(twin.ratings).toEqual([3]);
  // Graded once and rescheduled: the twin is a card like any other.
  expect(twin.state).not.toBe(0);

  // --- /stats: the honest empty state first (Phase 8 C) ---------------------
  // Everything this walk graded was a learning-step review of a card the demo
  // had barely started, and the retention denominator counts Review-state
  // reviews only. So the page has almost nothing to go on, and the thing it
  // must not do is draw a confident curve over it.
  await page.goto('/stats');
  await expect(page.getByRole('heading', { level: 1, name: 'Stats' })).toBeVisible();

  const retentionEmpty = page.getByTestId('stats-retention-empty');
  await expect(retentionEmpty).toBeVisible({ timeout: 60_000 });
  await expect(retentionEmpty).toContainText('Not enough reviews yet');
  await expect(page.getByTestId('stats-retention-rate')).toHaveCount(0);
  await expect(page.getByTestId('stats-calibration-empty')).toBeVisible();
  await expect(page.getByTestId('stats-calibration-dot')).toHaveCount(0);
  // Counts are exact at any size, so the maturity panel is drawn regardless —
  // and the cards this walk created are in it.
  await expect(page.getByTestId('stats-maturity')).toBeVisible();
  await expect(page.getByTestId('stats-card-total')).toBeVisible();

  // --- …and the numbers, once there is a history to read --------------------
  await seedHistory(page);
  await page.reload();

  await expect(page.getByTestId('stats-retention-empty')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('stats-retention-rate')).toHaveText(/^\d+%$/);
  await expect(page.getByTestId('stats-retention-denominator')).toContainText('reviews recalled');
  await expect(page.getByTestId('stats-retention-denominator')).toContainText(
    'already in the Review state',
  );

  await expect(page.getByTestId('stats-calibration-empty')).toHaveCount(0);
  const dots = page.getByTestId('stats-calibration-dot');
  expect(await dots.count()).toBeGreaterThan(0);
  for (const dot of await dots.all()) {
    // Nothing too thin to mean anything was drawn.
    expect(Number(await dot.getAttribute('data-count'))).toBeGreaterThanOrEqual(10);
  }

  // The workload panel is reading the same log: the seeded cohort answered on
  // four days inside the 30-day window, 24 cards each time.
  await expect(page.getByTestId('stats-workload-empty')).toHaveCount(0);
  await expect(page.locator('[data-testid="stats-workload-row"][data-reviewed="24"]')).toHaveCount(
    4,
  );
  // And the 24 graduated cards are in the Review state, on top of this walk's.
  expect(
    Number(await page.getByTestId('stats-state-review').textContent()),
  ).toBeGreaterThanOrEqual(24);
});
