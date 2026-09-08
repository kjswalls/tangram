/**
 * A phrase card's front, per token (HANDOFF.md, Phases 4–5 review fixes: "the
 * review card still renders `snapshot.simp` rather than per-token markup").
 *
 * The Add-time refusal cannot reach a card that was written before it existed,
 * so the case that matters is seeded straight into the database: a phrase whose
 * middle token cites no dictionary entry. On the front — before the flip, which
 * is when the learner is rehearsing it — that token must be marked, and the card
 * must say why.
 */
import { expect, test } from '@playwright/test';

import { ready, resetApp } from './helpers';

const CITED = { text: '我', entryId: '我|我[wo3]', pinyinMarked: 'wǒ' };
const KANKAN = { text: '看看', entryId: '看看|看看[kan4 kan5]', pinyinMarked: 'kànkan' };

test.describe('a phrase card front', () => {
  test('marks the token no dictionary row stands behind', async ({ page }) => {
    // No spine draw: the only card in the session is the one this spec writes.
    await resetApp(page, { newPerDay: 0 });
    await page.goto('/review');
    await ready(page);

    await page.evaluate(async (tokens) => {
      await window.__tangram.repo.addPhraseCard(tokens, 'I am just browsing.', {
        source: 'ask',
        addedAt: Date.now(),
      });
    }, [CITED, { text: '随看随买' }, KANKAN]);
    await page.reload();

    const face = page.getByTestId('phrase-face');
    await expect(face).toHaveText('我随看随买看看');
    await expect(face).toHaveAttribute('data-unverified', 'true');

    const tokens = page.getByTestId('phrase-face-token');
    await expect(tokens).toHaveCount(3);
    await expect(tokens.nth(0)).toHaveAttribute('data-unverified', 'false');
    await expect(tokens.nth(1)).toHaveAttribute('data-ai-generated', 'true');
    await expect(tokens.nth(2)).toHaveAttribute('data-unverified', 'false');

    // Said in words, not only in styling — and said before the answer is shown.
    await expect(page.getByTestId('phrase-face-warning')).toContainText('not verified');
    await expect(page.getByTestId('card-back')).toHaveCount(0);

    // The reading is the answer, so the front does not carry it.
    await expect(page.getByTestId('card-front')).not.toContainText('kànkan');
  });

  test('leaves a fully cited phrase unmarked', async ({ page }) => {
    await resetApp(page, { newPerDay: 0 });
    await page.goto('/review');
    await ready(page);

    await page.evaluate(async (tokens) => {
      await window.__tangram.repo.addPhraseCard(tokens, 'I am just looking.', {
        source: 'ask',
        addedAt: Date.now(),
      });
    }, [CITED, KANKAN]);
    await page.reload();

    await expect(page.getByTestId('phrase-face')).toHaveAttribute('data-unverified', 'false');
    await expect(page.getByTestId('phrase-face-warning')).toHaveCount(0);
    await expect(page.getByTestId('phrase-face-token')).toHaveCount(2);
  });
});
