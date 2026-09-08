import { expect, test, type Page } from '@playwright/test';

import { DASUAN, KANKAN, openReview, readerContext, reviewRows, seed, storedCard } from '../p2/fixtures';
import { ready, resetApp } from '../p3/helpers';

/**
 * The production direction (PLAN.md §3.3; Phase 8, builder B), as a learner
 * meets it: turn it on in /settings, add the reverse from the back of a card
 * you can already read, then be asked to *write* the word from its meaning.
 *
 * The four things these specs exist to prove, in the order they matter:
 *
 *  1. **The two directions are two memories.** Grading the production card
 *     leaves the recognition card's due date exactly where it was, and the
 *     other way round. They are separate rows; nothing coordinates them.
 *  2. **An exact answer needs no model.** `/api/recall` is routed to fail the
 *     test if it is called at all — and the suggestion still arrives, because a
 *     match against the headword is not a judgement call.
 *  3. **The front never shows the answer.** Not in the glosses, not in the
 *     sentence the word was mined from, which is blanked.
 *  4. **Turning the setting on costs nothing by itself.** It reveals the two
 *     controls that make production cards; pressing one is what makes a card.
 */

/** Throw the switch the way a person does, and wait for the row, not the box. */
async function enableProduction(page: Page): Promise<void> {
  await page.goto('/settings');
  await ready(page);
  const toggle = page.getByTestId('settings-production-direction');
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.waitForFunction(
    async () => (await window.__tangram.repo.getSettings()).productionDirection === true,
  );
}

test.describe('/review, both directions', () => {
  test('adds the reverse from a card back and schedules it on its own', async ({ page }) => {
    await openReview(page);
    await enableProduction(page);

    // Nothing was created by the setting itself.
    expect(await page.evaluate(() => window.__tangram.repo.allCards())).toHaveLength(0);

    await page.goto('/review');
    await ready(page);
    const [recognitionId] = await seed(page, [
      { entry: DASUAN, context: readerContext(), gradedDaysAgo: 30 },
    ]);

    // The control is on the back — after the meaning, which is when the learner
    // knows whether they could have written it.
    await expect(page.getByTestId('add-reverse')).toHaveCount(0);
    await page.getByTestId('reveal').click();
    const add = page.getByTestId('add-reverse-button');
    await expect(add).toBeEnabled();
    await add.click();
    await expect(page.getByTestId('add-reverse')).toHaveAttribute('data-phase', 'present');

    const cards = await page.evaluate(() => window.__tangram.repo.allCards());
    expect(cards).toHaveLength(2);
    const production = cards.find((card) => card.direction === 'production')!;
    expect(production.entryId).toBe(cards.find((card) => card.id === recognitionId)!.entryId);
    // One word, two cards.
    expect(production.wordId).toBe(cards.find((card) => card.id === recognitionId)!.wordId);

    // Grade the recognition card; the new twin is what is left to study.
    await page.getByTestId('grade-3').click();
    await expect(page.getByTestId('review-card')).toHaveAttribute('data-direction', 'production');
    const recognitionBefore = await storedCard(page, recognitionId);

    // The front asks in English and gives nothing away — not the word, not its
    // reading, and not the sentence it was mined from, which is blanked.
    const front = page.getByTestId('card-front');
    await expect(front).toContainText('to plan');
    await expect(front).not.toContainText('打算');
    await expect(front).not.toContainText('dǎsuàn');
    await expect(page.getByTestId('context-peek')).toContainText('明天去北京');
    await expect(page.getByTestId('context-peek')).not.toContainText('打算');

    // An exact answer is judged in the browser. Any request is a failure.
    let asked = 0;
    await page.route('**/api/recall', (route) => {
      asked += 1;
      return route.fulfill({ status: 500, body: '{}' });
    });

    await page.getByTestId('recall-answer').fill('打算');
    await page.getByTestId('recall-answer').press('Enter');

    await expect(page.getByTestId('card-back')).toBeVisible();
    await expect(page.getByTestId('production-answer')).toHaveText('打算');
    const suggestion = page.getByTestId('recall-suggestion');
    await expect(suggestion).toHaveAttribute('data-suggested', '3');
    await expect(page.getByTestId('grade-3')).toHaveAttribute('data-suggested', 'true');
    // No provider was asked, so there is no offline badge to explain one.
    await expect(page.getByTestId('recall-offline')).toHaveCount(0);
    expect(asked).toBe(0);

    // The learner grades it themselves, with a different key.
    await page.keyboard.press('2');
    await expect(page.getByTestId('review-empty')).toBeVisible();

    const rows = await reviewRows(page);
    const productionRows = rows.filter((row) => row.cardId === production.id);
    expect(productionRows).toHaveLength(1);
    expect(productionRows[0].rating).toBe(2);

    // The twin moved; the recognition card did not.
    const productionAfter = await storedCard(page, production.id);
    expect(productionAfter!.fsrs.reps).toBe(1);
    const recognitionAfter = await storedCard(page, recognitionId);
    expect(recognitionAfter!.due).toBe(recognitionBefore!.due);
    expect(recognitionAfter!.fsrs).toEqual(recognitionBefore!.fsrs);
  });

  test('accepts the other script, and counts the directions apart on Today', async ({ page }) => {
    await openReview(page);
    await enableProduction(page);
    await page.goto('/review');
    await ready(page);

    // Two words: one recognised, one to be produced. 看看 is written the same
    // in both scripts, so the "other script" half of this uses 学习/學習.
    const XUEXI = {
      id: '學習|学习[xue2 xi2]',
      simp: '学习',
      trad: '學習',
      pinyinNum: 'xue2 xi2',
      pinyinMarked: 'xuéxí',
      glosses: ['to learn', 'to study'],
      classifiers: [],
      properNoun: false,
      isVariant: false,
      surname: false,
      hskBand: 1 as const,
      freqRank: 300,
    };

    await page.evaluate(
      async ({ entry, other }) => {
        const repo = window.__tangram.repo;
        // The recognition card, then its production twin — the same pair the
        // "add the reverse" button makes, seeded so the spec starts at the card.
        await repo.addCardFromEntry(other, { source: 'lookup', addedAt: Date.now() }, undefined, 'test');
        await repo.addCardFromEntry(entry, { source: 'lookup', addedAt: Date.now() }, undefined, 'test');
        await repo.addCardFromEntry(
          entry,
          { source: 'lookup', addedAt: Date.now() },
          undefined,
          'test',
          'production',
        );
      },
      { entry: XUEXI, other: KANKAN },
    );

    // Today says what the learner signed up for, in two numbers.
    await page.goto('/');
    await ready(page);
    await expect(page.getByTestId('today-direction-split')).toBeVisible();
    await expect(page.getByTestId('today-recognition-count')).toHaveText('2');
    await expect(page.getByTestId('today-production-count')).toHaveText('1');

    // Take the two recognition cards out of the way rather than walking the
    // queue: they are graded, so they come back in minutes and what is left to
    // study is the one card this spec is about.
    await page.evaluate(async () => {
      const repo = window.__tangram.repo;
      for (const card of await repo.allCards()) {
        if (card.direction !== 'production') await repo.grade(card.id, 3);
      }
    });

    await page.goto('/review');
    await ready(page);
    await expect(page.getByTestId('review-card')).toHaveAttribute('data-direction', 'production');

    // Set to simplified; the traditional form is the same word and is accepted.
    await page.getByTestId('recall-answer').fill('學習');
    await page.getByTestId('recall-answer').press('Enter');
    const suggestion = page.getByTestId('recall-suggestion');
    await expect(suggestion).toHaveAttribute('data-suggested', '3');
    await expect(page.getByTestId('recall-why')).toContainText('traditional');
  });
});

/**
 * The other way in: a whole list at once (`components/lists/production-list-toggle.tsx`).
 *
 * This is the control that could do real damage — "also study production" over
 * a list of ninety words is ninety new cards if nothing stops it — so what is
 * pinned here is the stop: the day's remaining new-card allowance, and not one
 * card more, with the rest reported as waiting rather than silently dropped.
 */
test.describe('/lists, also study production', () => {
  test('adds reverse cards for a list, capped at the day allowance', async ({ page }) => {
    // `resetApp` wipes from /settings, the one route that neither draws new
    // cards nor materialises a list — so nothing can land a spine draw (and a
    // charge against today's allowance) after the reset (`tests/e2e/p3/helpers.ts`).
    await resetApp(page, { newPerDay: 1 });

    // A list of two words the learner has already met once each. They are
    // explicit adds, so they cost nothing against the cap — `newPerDay: 1` is
    // therefore exactly one reverse card today.
    const listId = await page.evaluate(
      async ({ first, second }) => {
        const repo = window.__tangram.repo;
        const list = await repo.createList({ name: 'Mine', kind: 'custom', owner: 'user' });
        for (const entry of [first, second]) {
          const card = await repo.addCardFromEntry(
            entry,
            { source: 'lookup', addedAt: Date.now() },
            undefined,
            'test',
          );
          await repo.grade(card.id, 3, Date.now() - 10 * 86_400_000);
          await repo.addListMembers(list.id, [entry.id]);
        }
        return list.id;
      },
      { first: DASUAN, second: KANKAN },
    );

    // Off in settings means the control is not there at all.
    await page.goto(`/lists/${listId}`);
    await ready(page);
    await expect(page.getByTestId('list-members')).toBeVisible();
    await expect(page.getByTestId('list-production')).toHaveCount(0);

    await enableProduction(page);
    await page.goto(`/lists/${listId}`);
    await ready(page);

    const toggle = page.getByTestId('list-production-toggle');
    await expect(toggle).not.toBeChecked();
    // Still nothing made: the setting opens the door, the toggle walks through.
    expect(
      await page.evaluate(async () =>
        (await window.__tangram.repo.allCards()).filter((card) => card.direction === 'production')
          .length,
      ),
    ).toBe(0);

    await toggle.click();

    await expect(page.getByTestId('list-production-status')).toContainText(
      '1 reverse card added today',
    );
    await expect(page.getByTestId('list-production-status')).toContainText('1 more');
    const twins = await page.evaluate(async () =>
      (await window.__tangram.repo.allCards()).filter((card) => card.direction === 'production'),
    );
    expect(twins).toHaveLength(1);
    // It was charged to the day, so the spine gets one word fewer rather than
    // the learner quietly getting a second allowance.
    const settings = await page.evaluate(() => window.__tangram.repo.getSettings());
    expect(Object.values(settings.introduced)).toEqual([1]);

    // Reopened, the choice is remembered — and the cap still holds.
    await page.reload();
    await ready(page);
    await expect(page.getByTestId('list-production-toggle')).toBeChecked();
    expect(
      await page.evaluate(async () =>
        (await window.__tangram.repo.allCards()).filter((card) => card.direction === 'production')
          .length,
      ),
    ).toBe(1);
  });
});
