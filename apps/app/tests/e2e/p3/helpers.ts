import { expect, type Page } from '@playwright/test';

import type { SettingsRow } from '@/lib/db';

/** The layout mounts the hook in an effect, so a fresh page has to wait for it. */
export async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => '__tangram' in window);
}

/**
 * A clean database for a spec.
 *
 * **`/read`, not Library.** The rule is unchanged — wipe from the one page that
 * neither draws new cards nor materialises a list, so the reset cannot race the
 * page — but the page changed: core.md C7 folded `/settings` into Library
 * *beside* the lists, and `ListsView` fills HSK membership in the background on
 * mount. The texts view is the quiet one now: a paste box, a dictionary gate,
 * and no reads of the learner's data at all.
 */
export async function resetApp(page: Page, settings?: Partial<SettingsRow>): Promise<void> {
  await page.goto('/read');
  await ready(page);
  await page.evaluate(async (patch) => {
    await window.__tangram.repo.resetAll();
    if (patch) await window.__tangram.repo.setSettings(patch);
  }, settings);
}

/** Grade every card that is currently new, as if a review session had run. */
export async function gradeAllNew(page: Page, rating: 1 | 2 | 3 | 4 = 3): Promise<number> {
  await ready(page);
  return page.evaluate(async (value) => {
    const repo = window.__tangram.repo;
    const fresh = (await repo.allCards()).filter((card) => card.fsrs.state === 0);
    for (const card of fresh) await repo.grade(card.id, value);
    return fresh.length;
  }, rating);
}

/**
 * Today's counts, read back out of the sentence (docs/plans/core.md C8).
 *
 * C8 replaced the two number tiles with one line of English, and a clause whose
 * count is zero **is not in the sentence at all** — "8 words to practise, 0 new
 * words to learn" is the tile grid with commas. So a missing clause reads as
 * zero here, which is what the old `toHaveText('0')` assertions meant.
 *
 * `practice` is the recognition cards waiting, `write` the production ones, and
 * `fresh` the new words the session will introduce; together they are what the
 * two tiles used to say, split the way Phase 8 asked for.
 */
export interface TodayCounts {
  practice: number;
  fresh: number;
  write: number;
}

/**
 * The number in the clause that contains `phrase`.
 *
 * **Split into clauses first.** The first version matched `(\d+)[^,.]*<phrase>`
 * across the whole sentence, relying on a comma to stop it — and
 * `joinClauses` writes exactly two clauses as "A and B" with **no comma**. So
 * on a two-clause day every count read back as the first clause's number:
 * "8 words to practise and 2 to write from memory" reported write = 8. Found by
 * C8's adversarial review; every call site happened to pass a one-clause
 * sentence, which is why the suite was green.
 */
function countIn(sentence: string, phrase: string): number {
  const counts = sentence
    .split('.')[0]
    .split(/,\s*|\s+and\s+/)
    .filter((clause) => clause.includes(phrase))
    .map((clause) => Number(/(\d+)/.exec(clause)?.[1] ?? '0'));
  return counts[0] ?? 0;
}

export async function todayCounts(page: Page): Promise<TodayCounts> {
  const sentence = (await page.getByTestId('today-sentence').textContent()) ?? '';
  // "Counting what is waiting…" — the summary has not landed, and reporting
  // three zeroes here would let a caller assert an empty day that is merely
  // an unfinished read.
  if (sentence.includes('Counting')) return { practice: -1, fresh: -1, write: -1 };
  return {
    practice: countIn(sentence, 'to practise'),
    fresh: countIn(sentence, 'new word'),
    write: countIn(sentence, 'to write'),
  };
}

/** Poll until Today says exactly this. Partial: unnamed counts are not checked. */
export async function expectTodayCounts(
  page: Page,
  expected: Partial<TodayCounts>,
  options: { timeout?: number } = {},
): Promise<void> {
  await expect
    .poll(
      async () => {
        const counts = await todayCounts(page);
        return Object.fromEntries(
          Object.keys(expected).map((key) => [key, counts[key as keyof TodayCounts]]),
        );
      },
      {
        message: `Today's sentence should report ${JSON.stringify(expected)}`,
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      },
    )
    .toEqual(expected);
}
