/**
 * The word sheet and the character sheet (docs/plans/core.md C4; product rule 2).
 *
 * Tap a word → it opens with its senses and an Add. Tap a character inside it →
 * that character opens on its own, with its decomposition. Escape → focus goes
 * back to what was tapped. All three are C4's acceptance criteria and all three
 * are about a surface a unit test cannot see: a sheet is geometry, focus and a
 * stacking order.
 */
import { expect, test, type Page } from '../dict';

import { expectBaseText } from '../hanzi';
import { DEMO_PARAGRAPH, readText, resetApp, token } from '../p5/helpers';

const PHONE = { width: 390, height: 844 };
/** 继续 — two characters, in the demo paragraph, one reading. */
const WORD = '继续';
/** 打扫 — two characters, TWO senses. CC-CEDICT gives 继续 only one. */
const TWO_SENSES = '打扫';
/** 看 — the polyphone in the paragraph: kān and kàn. */
const POLYPHONE = '看';
/** …and 打扫's entry id, which the "Mark known" case asserts by hand. */
const TWO_SENSES_ID = '打掃|打扫[da3 sao3]';

async function openWord(page: Page, word = WORD): Promise<void> {
  await resetApp(page, { knownBand: 2, newPerDay: 0 });
  await readText(page, DEMO_PARAGRAPH);
  await token(page, word).click();
  await expect(page.getByTestId('word-sheet')).toBeVisible();
}

/**
 * **This spec needs a dictionary on the device**, so it accepts the ask once
 * before each test — `tests/e2e/dict.ts`, which is also where the next person
 * to change this behaviour changes it. The default there is `'ask'`, a fresh
 * origin with nothing stored, because that is what a fresh origin really gets
 * now that `<DictGate>`'s mount probes instead of downloading.
 */
test.use({ dictionary: 'installed' });

test.describe('the word sheet', () => {
  test('opens on a tap with every sense and an Add', async ({ page }) => {
    await openWord(page, TWO_SENSES);

    const sheet = page.getByTestId('word-sheet');
    await expect(sheet).toHaveAttribute('role', 'dialog');
    await expectBaseText(sheet, TWO_SENSES);
    await expect(sheet.getByTestId('entry-detail')).toBeVisible();
    await expect(sheet.getByTestId('add-card')).toBeVisible();

    // Every sense the entry has, not the first one: the sheet is where a
    // learner decides which one they met. 打扫 carries two; CC-CEDICT gives
    // 继续 a single semicolon-joined gloss, which is why this case has its own
    // word.
    await expect(sheet.getByTestId('entry-gloss')).toHaveText(['to clean', 'to sweep']);
  });

  test('refuses to pick a reading for a polyphone on the learner’s behalf', async ({ page }) => {
    // The property C4 says to keep through the fold, and the reason the word
    // sheet is `EntryDetail` re-homed rather than a new panel.
    await openWord(page, POLYPHONE);
    const sheet = page.getByTestId('word-sheet');
    await expect(sheet.getByTestId('reading-pinyin')).toHaveText(['kān', 'kàn']);
    await expect(sheet.getByTestId('reading-option')).toHaveCount(2);
  });

  test('is NOT modal, because a reader taps word after word', async ({ page }) => {
    await openWord(page);
    // No backdrop over the passage: the next tap opens the next word rather
    // than costing a gesture to dismiss this one.
    await expect(page.getByTestId('word-sheet-backdrop')).toHaveCount(0);
    await expect(page.getByTestId('word-sheet-layer')).toHaveAttribute('data-modal', 'false');

    await token(page, '工作').click();
    await expectBaseText(page.getByTestId('word-sheet'), '工作');
  });

  test('“Mark known” marks the word on screen, never the one before it', async ({ page }) => {
    /**
     * The regression the fold introduced and the adversarial review caught. The
     * sheet is one long-lived instance: a tap swaps the word rather than
     * remounting, so the reading `EntryDetail` last reported outlived the word
     * it belonged to. Between the tap and the entries resolving — and for ever,
     * on a word with no CC-CEDICT headword — "Mark known" was enabled and wrote
     * the PREVIOUS word's id, and the passage recoloured the wrong word known.
     */
    await openWord(page, WORD);
    await expect(page.getByTestId('entry-detail')).toBeVisible();

    await token(page, TWO_SENSES).click();
    await expect(page.getByTestId('entry-detail')).toBeVisible();
    await page.getByTestId('mark-known').click();
    await expect(page.getByTestId('mark-known')).toHaveText('Marked known');

    const known = await page.evaluate(async () => window.__tangram.repo.knownEntryIds());
    expect(known).toHaveLength(1);
    // 打扫, not 继续.
    expect(known[0]).toContain(TWO_SENSES_ID);
  });

  test('covers the lower two thirds at 390px, with the tapped word still above it', async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await openWord(page);

    const measure = () =>
      page.evaluate((word) => {
        const sheet = document.querySelector('[data-testid="word-sheet"]');
        const tapped = document.querySelector(`[data-token="${word}"]`);
        if (!sheet || !tapped) return null;
        const s = sheet.getBoundingClientRect();
        const t = tapped.getBoundingClientRect();
        return {
          top: s.top,
          height: s.height,
          viewport: window.innerHeight,
          tappedBottom: t.bottom,
        };
      }, WORD);

    const geometry = await measure();
    expect(geometry).not.toBeNull();
    const { height, viewport } = geometry!;
    // "The lower two thirds", both ways: a cap and a floor. A strip pinned to
    // the bottom edge is not the surface the learner is now working in.
    expect(height).toBeLessThanOrEqual(viewport * 0.67 + 1);
    expect(height).toBeGreaterThanOrEqual(viewport * 0.5 - 1);

    /**
     * …and the word that was tapped is lifted clear of it — **polled**, because
     * the lift is asynchronous by design. `reader-screen.tsx` waits two frames
     * after the sheet opens: the first commits the column's bottom padding and
     * the second lays it out, and there is nothing to scroll until it has.
     * Reading the geometry once was a race the spec happened to win until the
     * passage grew per-character ruby at C5b.
     */
    await expect
      .poll(async () => {
        const now = await measure();
        return now === null ? 1 : now.tappedBottom - now.top;
      }, { timeout: 5_000 })
      .toBeLessThanOrEqual(0);
  });
});

test.describe('the character sheet', () => {
  test('opens from a character inside the word, with its decomposition', async ({ page }) => {
    await openWord(page);

    const characters = page.getByTestId('open-character');
    await expect(characters).toHaveCount(2);
    await characters.first().click();

    const sheet = page.getByTestId('char-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('char-sheet-hanzi')).toHaveAttribute('data-hanzi', '继');
    // The decomposition block — the thing that makes this a character sheet and
    // not a narrow word sheet.
    await expect(sheet.getByTestId('char-decomposition')).toBeVisible();
    await expect(sheet.getByTestId('char-ids')).toContainText('⿰');
    // …and the licence notice that has to travel with it.
    await expect(sheet.getByTestId('char-decomposition')).toContainText('Make Me a Hanzi');
  });

  test('Escape closes it and focus goes back to the character that was tapped', async ({
    page,
  }) => {
    await openWord(page);
    const first = page.getByTestId('open-character').first();
    await first.click();
    await expect(page.getByTestId('char-sheet')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('char-sheet')).toHaveCount(0);
    // The opener, not the document body: a sheet that drops focus on the floor
    // strands a keyboard learner at the top of the page.
    await expect(first).toBeFocused();
  });

  test('an Add from it writes a card with the sense chosen and where it came from', async ({
    page,
  }) => {
    await openWord(page);
    await page.getByTestId('open-character').first().click();
    const sheet = page.getByTestId('char-sheet');
    await expect(sheet.getByTestId('entry-detail')).toBeVisible();

    await sheet.getByTestId('add-card').click();
    await expect(sheet.getByTestId('add-state')).toContainText('Added');

    const saved = await page.evaluate(async () => {
      const rows = await window.__tangram.repo.allCards();
      return rows.map((card) => ({
        entryId: card.entryId,
        senseIndex: card.senseIndex,
        source: card.context?.source,
        sentence: card.context?.sentence,
        offset: card.context?.offset,
        length: card.context?.length,
        simp: 'simp' in card.snapshot ? card.snapshot.simp : '',
        dictVersion: card.snapshot.dictVersion,
        snapshot: card.snapshot as unknown as Record<string, unknown>,
      }));
    });
    expect(saved).toHaveLength(1);
    expect(saved[0].simp).toBe('继');
    /**
     * The entry and the sense, which the test is named after and which were
     * collected and then never compared to anything.
     *
     * `senseIndex` is **undefined** and that is the correct answer: `EntryDetail`'s
     * Add chooses a *reading*, not a sense — `addCardChecked`'s `senseIndex`
     * argument is only filled by the ask panel's per-match Add — so a card
     * added here is about the whole entry. Asserting the value rather than
     * asserting nothing is what makes a future change to that visible.
     */
    expect(saved[0].entryId).toMatch(/^繼\|继\[/);
    expect(saved[0].senseIndex).toBeUndefined();
    expect(saved[0].source).toBe('reader');
    expect(saved[0].sentence).toContain(WORD);
    expect(saved[0].dictVersion).toMatch(/\d/);
    /**
     * **The character's own span, not the word's.** `lib/srs/context.ts` uses
     * `offset`/`length` to decide what a card back highlights (PLAN.md §1,
     * commitment 2), and the sheet used to inherit the whole tapped word's —
     * so a one-character card highlighted 继续 for the life of the card.
     */
    expect(saved[0].length).toBe(1);
    expect(saved[0].sentence?.slice(saved[0].offset ?? 0, (saved[0].offset ?? 0) + 1)).toBe('继');
    // The licence boundary, at the far end: nothing from `decomp.json` reached
    // the row, however the sheet rendered it (CLAUDE.md, "Data and licences").
    for (const field of ['decomposition', 'radical', 'definition']) {
      expect(saved[0].snapshot, field).not.toHaveProperty(field);
    }
  });
});

test.describe('the in-context gloss line', () => {
  test('names one of the entry’s own senses when the module answers', async ({ page }) => {
    await openWord(page);

    const line = page.getByTestId('context-gloss');
    await expect(line).toBeVisible({ timeout: 20_000 });

    // The sense named is one the entry itself lists — not the model's words.
    const named = (await page.getByTestId('context-gloss-sense').textContent())?.trim();
    const senses = (await page.getByTestId('entry-gloss').allTextContents()).map((s) => s.trim());
    expect(senses).toContain(named);
  });

  test('is ABSENT when the module is unavailable, and nothing else moves', async ({ page }) => {
    await page.route('**/api/ask', (route) =>
      route.fulfill({ status: 503, body: JSON.stringify({ error: 'unavailable' }) }),
    );
    await openWord(page);

    const sheet = page.getByTestId('word-sheet');
    await expect(sheet.getByTestId('entry-detail')).toBeVisible();
    await expect(sheet.getByTestId('add-card')).toBeVisible();
    // Absent, not an empty box: the senses and the Add do not wait on it.
    await expect(page.getByTestId('context-gloss')).toHaveCount(0);
  });
});
