/**
 * The sentence a token was met in (PLAN.md §3.5).
 *
 * A card's provenance is "the sentence you met the word in" (§1, commitment 2),
 * so this has to answer with a *span*, not just a string: the review back
 * highlights the target with `context.offset`/`context.length`
 * (`lib/srs/context.ts`), and an offset that survives the trimming and the
 * 200-character cap is the whole job. Every transformation below moves the
 * offset with the text; nothing here is allowed to return a span that does not
 * still point at the word.
 *
 * The bounds are the ones §3.5 names — `。！？；…`, a newline, and ASCII `.!?`.
 * `，`, `、` and `：` are deliberately not bounds: a Chinese sentence commonly
 * runs three clauses on commas, and cutting at them throws away the context the
 * card exists to carry.
 */

/** Sentence-final punctuation, per §3.5. The terminator stays on the sentence. */
export const SENTENCE_BREAKS = '。！？；…\n.!?';

/** §3.5's cap. A card back is not the place for a whole paragraph. */
export const MAX_SENTENCE_CHARS = 200;

/** The provenance span: the sentence, and where the target sits inside it. */
export interface SentenceContext {
  sentence: string;
  /** UTF-16 offset of the target inside `sentence`. */
  offset: number;
  /** Length of the target in UTF-16 code units. */
  length: number;
}

export function isSentenceBreak(char: string): boolean {
  return char.length > 0 && SENTENCE_BREAKS.includes(char);
}

/**
 * Trim the surrounding whitespace and carry the span with it. The clamps are
 * not defensive noise: a caller may hand in a span that overlaps the whitespace
 * being removed (a `text` token, a bad offset), and the invariant that matters
 * is `0 <= offset <= offset + length <= sentence.length`.
 */
function trimSpan(text: string, offset: number, length: number): SentenceContext {
  const lead = text.length - text.trimStart().length;
  const sentence = text.trim();

  let start = offset - lead;
  let width = length;
  if (start < 0) {
    width += start;
    start = 0;
  }
  if (start > sentence.length) start = sentence.length;
  if (width < 0) width = 0;
  if (start + width > sentence.length) width = sentence.length - start;

  return { sentence, offset: start, length: width };
}

/**
 * Cap the sentence at `MAX_SENTENCE_CHARS`, keeping the target inside the
 * window and centring it in what is left. A target longer than the cap is
 * itself truncated — the window still starts at the word rather than sliding
 * off it, because a highlight that points at nothing is worse than a short one.
 */
function capSpan({ sentence, offset, length }: SentenceContext): SentenceContext {
  if (sentence.length <= MAX_SENTENCE_CHARS) return { sentence, offset, length };

  const width = Math.min(length, MAX_SENTENCE_CHARS);
  const slack = MAX_SENTENCE_CHARS - width;

  let start = offset - Math.floor(slack / 2);
  // Keep the whole target inside the window …
  start = Math.min(start, offset);
  start = Math.max(start, offset + width - MAX_SENTENCE_CHARS);
  // … then inside the sentence. Both clamps preserve the one above, because
  // `offset + width <= sentence.length`.
  start = Math.min(start, sentence.length - MAX_SENTENCE_CHARS);
  start = Math.max(start, 0);

  // The window can open or close on a space, so trim once more.
  return trimSpan(sentence.slice(start, start + MAX_SENTENCE_CHARS), offset - start, width);
}

/**
 * The maximal run around `[start, end)` bounded by sentence punctuation,
 * trimmed and capped, with the target's position inside it.
 *
 * The scan looks *backwards from `start`* and *forwards from `end`*, so a bound
 * can never be found inside the token itself — a word token is hanzi only, but
 * a caller passing a wider span still gets the run that contains all of it.
 */
export function sentenceAt(text: string, start: number, end: number): SentenceContext {
  const limit = text.length;
  const from = Math.min(Math.max(start, 0), limit);
  const to = Math.min(Math.max(end, from), limit);

  let open = 0;
  for (let i = from; i > 0; i -= 1) {
    if (isSentenceBreak(text[i - 1])) {
      open = i;
      break;
    }
  }

  let close = limit;
  for (let i = to; i < limit; i += 1) {
    if (isSentenceBreak(text[i])) {
      close = i + 1;
      break;
    }
  }

  return capSpan(trimSpan(text.slice(open, close), from - open, to - from));
}

/** `sentenceAt` for a segmentation token. */
export function sentenceForToken(
  text: string,
  token: { start: number; end: number },
): SentenceContext {
  return sentenceAt(text, token.start, token.end);
}
