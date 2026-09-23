/**
 * Which punctuation has to stay on a line with the word next to it
 * (the first-run audit's "Defects found, not fixed", item 2).
 *
 * Chinese typesetting forbids **closing** punctuation at the start of a line
 * and **opening** punctuation at the end of one (CLREQ's 行首禁则 and 行尾禁则).
 * A browser applies that rule inside a run of text on its own. The reader's
 * words are not text to the line breaker, though: each is a `<button>`, a
 * button is an atomic inline, and CSS Text 3 gives every atomic inline a break
 * opportunity on both sides "even when adjacent to a character that would
 * normally suppress them". So "，" went to the start of the next line whenever
 * the word before it happened to end one.
 *
 * `<HanziText>` answers that by wrapping a word together with the punctuation
 * that must travel with it. This module decides what that is, and nothing else:
 * it never changes a run's text, never moves a character from one run to
 * another, and never touches segmentation. The concatenated text of the pieces
 * is always the run's text, in order.
 */

/**
 * May not start a line: CLREQ's list (the pause and stop marks, the closing
 * quotes and brackets, the connector and the interpunct), the ellipsis and the
 * dash — which may not be split, so neither half may start a line — and the
 * ASCII marks a pasted text uses in their place.
 */
const CLOSING = new Set([
  ...'，。、；：？！．',
  ...'」』）】》〉〕］｝〗〙〞”’',
  ...'…‥—～·・',
  ...',.;:?!)]}',
]);

/** May not end a line: the opening quotes and brackets (CLREQ's 行尾禁则). */
const OPENING = new Set([...'「『（【《〈〔［｛〖〘〝“‘', ...'([{']);

export function isClosingPunctuation(char: string): boolean {
  return CLOSING.has(char);
}

export function isOpeningPunctuation(char: string): boolean {
  return OPENING.has(char);
}

/**
 * How a plain run between words divides.
 *
 * - `lead` — its leading closing marks, which belong on the line with the word
 *   **before** the run;
 * - `rest` — whatever is free to break as ordinary text;
 * - `trail` — its trailing opening marks, which belong on the line with the
 *   word **after** it.
 *
 * `lead + rest + trail` is always `text`. A side with no word to glue to is
 * empty, and so is everything when there is nothing to glue.
 */
export interface GlueSplit {
  lead: string;
  rest: string;
  trail: string;
}

export function splitForGlue(text: string, wordBefore: boolean, wordAfter: boolean): GlueSplit {
  // Every mark in both sets is one UTF-16 code unit, so indexing by code unit
  // cannot land between the halves of a surrogate pair: it stops at the first
  // character that is not one of them.
  let lead = 0;
  if (wordBefore) {
    while (lead < text.length && CLOSING.has(text[lead]!)) lead += 1;
  }
  let trail = text.length;
  if (wordAfter) {
    while (trail > lead && OPENING.has(text[trail - 1]!)) trail -= 1;
  }
  return {
    lead: text.slice(0, lead),
    rest: text.slice(lead, trail),
    trail: text.slice(trail),
  };
}
