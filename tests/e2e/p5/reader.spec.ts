import { expect, test } from '@playwright/test';

import {
  DEMO_PARAGRAPH,
  highlighted,
  JIXU_SENTENCE,
  onlyCard,
  readText,
  ready,
  resetApp,
  token,
  tokenStates,
} from './helpers';

/**
 * PLAN.md §4, P5. Every line of the acceptance row is here:
 *
 *   paste a paragraph → tokens coloured; with `knownBand: 2` an HSK 1–2 token
 *   is `known`; tap → the panel carries the sentence; Add → the review back
 *   shows that sentence with the target highlighted; "Mark known" recolours
 *   immediately; the text survives navigation.
 *
 * The database is the fixture, through `window.__tangram` (§ Phase 0's test
 * hook). `newPerDay: 0` throughout: opening `/review` introduces the day's
 * spine words (HANDOFF.md, "Phases 1–3 review fixes"), and these specs are
 * about the one card the reader mined.
 */

/** 我 is HSK 1, 面包 HSK 1, 继续 HSK 3 — the three the specs lean on. */
const KNOWN_WORD = '我';
const NEW_WORD = '继续';

test.describe('/read', () => {
  test('segments a pasted paragraph and colours every token', async ({ page }) => {
    await resetApp(page, { knownBand: 2, newPerDay: 0 });
    await readText(page, DEMO_PARAGRAPH);

    const states = await tokenStates(page);
    expect(states.length).toBeGreaterThan(60);
    // Every word token has a state, and it is one of the three §3.3 defines.
    expect(states.every((state) => ['known', 'learning', 'new'].includes(state))).toBe(true);
    expect(new Set(states).size).toBeGreaterThan(1);

    // Punctuation is a `text` token: rendered, never coloured, never tappable.
    await expect(page.locator('[data-testid="reader-token"][data-token="。"]')).toHaveCount(0);
    await expect(page.getByTestId('reader-text')).toContainText('。');

    // The counts line adds up to the tokens on screen.
    const known = states.filter((state) => state === 'known').length;
    const learning = states.filter((state) => state === 'learning').length;
    const fresh = states.filter((state) => state === 'new').length;
    await expect(page.getByTestId('reader-counts')).toHaveText(
      `${fresh} new · ${learning} learning · ${known} known`,
    );
  });

  test('knownBand governs the colour: with 2, every HSK 1–2 word is known', async ({ page }) => {
    await resetApp(page, { knownBand: 1, newPerDay: 0 });
    await readText(page, DEMO_PARAGRAPH);

    // 我 is HSK 1, so it is known at either setting.
    await expect(token(page, KNOWN_WORD)).toHaveAttribute('data-state', 'known');
    await expect(token(page, KNOWN_WORD)).toHaveClass(/token-known/);
    // 继续 is HSK 3 — above both settings, and the learner has no card for it.
    await expect(token(page, NEW_WORD)).toHaveAttribute('data-state', 'new');
    await expect(token(page, NEW_WORD)).toHaveClass(/token-new/);

    const atBandOne = (await tokenStates(page)).filter((state) => state === 'known').length;

    // Raising the band recolours the text in place — no re-segmentation.
    await page.evaluate(() => window.__tangram.repo.setSettings({ knownBand: 2 }));
    await expect
      .poll(async () => (await tokenStates(page)).filter((state) => state === 'known').length)
      .toBeGreaterThan(atBandOne);

    await expect(token(page, KNOWN_WORD)).toHaveAttribute('data-state', 'known');
    await expect(token(page, NEW_WORD)).toHaveAttribute('data-state', 'new');
  });

  test('a tap opens the panel carrying the sentence the word was met in', async ({ page }) => {
    await resetApp(page, { knownBand: 2, newPerDay: 0 });
    await readText(page, DEMO_PARAGRAPH);

    await token(page, NEW_WORD).click();

    const panel = page.getByTestId('reader-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(NEW_WORD);
    // The provenance line the frozen panel renders: the whole sentence, bounded
    // by the full stops on either side of it (§3.5).
    await expect(panel).toContainText(JIXU_SENTENCE);
    await expect(panel).toContainText('from reader');
    await expect(panel.getByTestId('entry-detail')).toBeVisible();
    await expect(panel.getByTestId('reading-pinyin').first()).toHaveText('jìxù');
  });

  test('Add mines a card whose review back highlights the sentence', async ({ page }) => {
    await resetApp(page, { knownBand: 2, newPerDay: 0 });
    await readText(page, DEMO_PARAGRAPH);

    await token(page, NEW_WORD).click();
    await page.getByTestId('add-card').click();
    await expect(page.getByTestId('add-state')).toContainText('Added to your cards');

    const cards = await onlyCard(page);
    expect(cards).toHaveLength(1);
    const [card] = cards;
    expect(card.simp).toBe(NEW_WORD);
    expect(card.context?.source).toBe('reader');
    expect(card.context?.sentence).toBe(JIXU_SENTENCE);
    // The span points at the word — this is exactly what the back highlights.
    expect(highlighted(card.context)).toBe(NEW_WORD);

    // The token recolours behind the panel: it is a card now, so it is learning.
    await expect(token(page, NEW_WORD)).toHaveAttribute('data-state', 'learning');

    // And the same sentence is on the back of the card in the review session.
    await page.goto('/review');
    await ready(page);
    await expect(page.getByTestId('card-front')).toContainText(NEW_WORD);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('context-back')).toHaveText(JIXU_SENTENCE);
    await expect(page.getByTestId('context-target')).toHaveText(NEW_WORD);
  });

  test('"Mark known" recolours the token immediately, without re-segmenting', async ({ page }) => {
    await resetApp(page, { knownBand: 2, newPerDay: 0 });
    await readText(page, DEMO_PARAGRAPH);

    // Count the segment requests from here on: the recolour must not cause one.
    let segmentCalls = 0;
    page.on('request', (request) => {
      if (request.url().includes('/api/dict/segment')) segmentCalls += 1;
    });

    const target = token(page, NEW_WORD);
    await expect(target).toHaveAttribute('data-state', 'new');
    await target.click();
    await page.getByTestId('mark-known').click();

    await expect(target).toHaveAttribute('data-state', 'known');
    await expect(target).toHaveClass(/token-known/);
    await expect(page.getByTestId('mark-known')).toHaveText('Marked known');
    expect(segmentCalls).toBe(0);

    const known = await page.evaluate(() => window.__tangram.repo.knownEntryIds());
    expect(known.some((id) => id.startsWith(`${NEW_WORD}|`) || id.includes(`|${NEW_WORD}[`))).toBe(
      true,
    );
  });

  test('the text survives navigation, and a reload finds it in the saved texts', async ({
    page,
  }) => {
    await resetApp(page, { knownBand: 2, newPerDay: 0 });
    await readText(page, DEMO_PARAGRAPH);

    const before = await page.getByTestId('reader-token').count();

    // Client-side navigation, the way the nav works: the store keeps the text.
    await page.getByRole('link', { name: 'Review' }).click();
    await expect(page).toHaveURL(/\/review$/);
    await page.getByRole('link', { name: 'Read' }).click();
    await expect(page).toHaveURL(/\/read$/);
    await expect(page.getByTestId('reader-text')).toContainText(NEW_WORD);
    expect(await page.getByTestId('reader-token').count()).toBe(before);

    // A reload empties the store, and the `texts` row is what is left (§3.5).
    await page.reload();
    await ready(page);
    await expect(page.getByTestId('reader-input')).toHaveValue('');
    const saved = page.getByTestId('saved-text');
    await expect(saved).toHaveCount(1);
    await saved.first().click();
    await expect(page.getByTestId('reader-text')).toContainText(NEW_WORD);
    expect(await page.getByTestId('reader-token').count()).toBe(before);
  });

  test('Extend looks up the span two tokens make: 买 + 东西 → 买东西', async ({ page }) => {
    await resetApp(page, { knownBand: 2, newPerDay: 0 });
    await readText(page, DEMO_PARAGRAPH);

    await token(page, '买').click();
    const panel = page.getByTestId('reader-panel');
    await expect(panel.getByTestId('lookup-panel')).toContainText('买');

    const extend = page.getByTestId('extend-span');
    await expect(extend).toHaveText('Extend to 东西');
    await extend.click();

    // The panel is now looking at the concatenated span, resolved through
    // `/api/dict/search` as an exact headword.
    await expect(panel.getByTestId('entry-detail')).toBeVisible();
    await expect(panel.getByTestId('reading-pinyin').first()).toHaveText('mǎidōngxi');
    await expect(panel.getByTestId('lookup-panel').locator('h2')).toHaveText('买东西');

    // Adding it keeps the sentence, as a single-token add does.
    await page.getByTestId('add-card').click();
    await expect(page.getByTestId('add-state')).toContainText('Added to your cards');
    const [card] = await onlyCard(page);
    expect(card.simp).toBe('买东西');
    expect(card.context?.source).toBe('reader');
    expect(highlighted(card.context)).toBe('买东西');
  });
});
