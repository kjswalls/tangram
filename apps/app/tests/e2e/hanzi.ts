import { expect, type Locator } from '@playwright/test';

/**
 * Reading a region's text **without the ruby readings** (core.md C3).
 *
 * C3 put one `<ruby>` per character behind every Chinese run, and `<rt>` is a
 * child of the element it annotates — so `textContent` interleaves the two:
 * `打算` reads back as `打dǎ算suàn`. Every `toContainText('打算')` in this suite
 * broke on that, which is a nuisance. The *dangerous* half is the other
 * direction: `not.toContainText('打算')` — the production card's "the front may
 * not contain the answer" guarantee, and the review card's "the graded one is
 * gone" — keeps passing against a front that shows the word in full, because
 * the interleaved string no longer contains the substring. Those assertions
 * would have gone quietly vacuous.
 *
 * So both directions go through here. `baseText()` returns what the old
 * `textContent` returned: the same nodes with the `<rt>` elements dropped —
 * and the `<rp>` parentheses with them, which `<HanziText>` emits so that a
 * screen reader with no ruby support says "打 (dǎ)" rather than "打dǎ".
 * It is deliberately *not* `data-hanzi` — that attribute carries only the
 * hanzi of one `<HanziText>`, and these assertions are about whole regions
 * (`card-front` is hanzi plus glosses plus a peek line).
 */
export function baseText(scope: Locator): Promise<string> {
  return scope.evaluate((node) => {
    const clone = node.cloneNode(true) as HTMLElement;
    for (const node of clone.querySelectorAll('rt, rp')) node.remove();
    return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

export interface BaseTextOptions {
  timeout?: number;
}

function poll(scope: Locator, message: string, options: BaseTextOptions) {
  return expect.poll(() => baseText(scope), {
    message,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  });
}

/** `expect(scope).toContainText(text)`, with the readings stripped. */
export async function expectBaseText(
  scope: Locator,
  text: string,
  options: BaseTextOptions = {},
): Promise<void> {
  await poll(
    scope,
    `base text of ${scope} should contain ${text}`,
    options,
  ).toContain(text);
}

/**
 * `expect(scope).not.toContainText(text)`, with the readings stripped — the
 * direction that would otherwise pass for the wrong reason.
 */
export async function expectNoBaseText(
  scope: Locator,
  text: string,
  options: BaseTextOptions = {},
): Promise<void> {
  await poll(
    scope,
    `base text of ${scope} should not contain ${text}`,
    options,
  ).not.toContain(text);
}

/** `expect(scope).toHaveText(text)`, with the readings stripped. */
export async function expectExactBaseText(
  scope: Locator,
  text: string,
  options: BaseTextOptions = {},
): Promise<void> {
  await poll(scope, `base text of ${scope} should be ${text}`, options).toBe(
    text,
  );
}

/**
 * The base text of every element the locator resolves to, in DOM order — the
 * readings-stripped `evaluateAll(nodes => nodes.map(n => n.textContent))`.
 */
export function baseTexts(scope: Locator): Promise<string[]> {
  return scope.evaluateAll((nodes) =>
    nodes.map((node) => {
      const clone = node.cloneNode(true) as HTMLElement;
      for (const node of clone.querySelectorAll('rt, rp')) node.remove();
      return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
    }),
  );
}

/**
 * Every reading rendered inside `scope`, as the `<rt>` elements carry them.
 *
 * The counterpart to `baseText()`, and the reason it has to exist: `baseText()`
 * strips the `<rt>`s, so a `not.toContain('dǎsuàn')` through it can no longer
 * see a reading at all and passes for any front, including one that prints the
 * answer. A card front that must not give the reading away is asserted against
 * this list instead.
 */
export function readingsIn(scope: Locator): Promise<string[]> {
  return scope.evaluate((node) =>
    [...node.querySelectorAll('rt')].map((rt) => (rt.textContent ?? '').trim()).filter(Boolean),
  );
}

/**
 * No reading anywhere under `scope` belongs to `word` — neither a whole
 * word-level annotation nor any one of its syllables.
 *
 * `syllables` is spelled out by the caller because splitting marked pinyin into
 * syllables is its own problem and getting it subtly wrong here would weaken
 * the assertion invisibly.
 */
export async function expectNoReadingOf(
  scope: Locator,
  word: string,
  syllables: readonly string[],
): Promise<void> {
  /**
   * Asserted **term by term**, and not with `expect.not.arrayContaining`.
   *
   * `arrayContaining([a, b, c])` matches an array holding *all* of them, so
   * its negation passes as soon as *one* is missing — and this helper is
   * handed the word-level annotation together with its syllables, of which a
   * rendered run carries one set or the other, never both. So the negated
   * matcher passed for every input it will ever see, including a front
   * printing the answer in full. That is the second time the readings-vs-base
   * distinction produced a test that could not fail; the first is the reason
   * this file exists.
   */
  const forbidden = [word, ...syllables];
  await expect
    .poll(
      async () => {
        const found = await readingsIn(scope);
        return forbidden.filter((term) => found.includes(term));
      },
      { message: `no <rt> under ${scope} may read ${word}` },
    )
    .toEqual([]);
}
