/**
 * Syllable-to-character alignment (docs/plans/core.md C3, risk R5).
 *
 * **This is the function the audits did not have.** `Entry.pinyinNum` is a
 * space-separated syllable list; `lib/dict/pinyin.ts` has `markSyllable()` for
 * one syllable and `toMarked()` for a whole word, and **nothing that maps
 * syllable *k* to character *k***. Per-character ruby needs exactly that, and
 * the naive zip is right most of the time and wrong in ways a learner cannot
 * detect — which is the worst kind of wrong, because the product's promise is
 * that every reading on screen comes from the cited dictionary row.
 *
 * So the rule is: **align, or say you could not.** When the two sides disagree
 * this returns `mode: 'fallback'` and the caller renders one annotation over
 * the whole run (`<ruby>打算<rt>dǎsuàn</rt></ruby>`) rather than guessing. A
 * wrong per-character reading is worse than a correct word-level one.
 *
 * The cases that break a zip, each covered by a named test:
 *
 * - **Latin runs** — `AA制`, `3C`, `卡拉OK`. CC-CEDICT writes these with one
 *   token per Latin letter (`[ka3 la1 O K]`), so they zip correctly; the hazard
 *   is assuming they do not and special-casing them into a fallback.
 * - **`·`**, CC-CEDICT's name separator, and **`,` / `，`**, its proverb clause
 *   separator. These appear in the headword AND in the reading, so they are
 *   consumed on both sides and the character keeps no annotation.
 * - **Erhua `r5`** — a syllable that is also a character (儿). `一点儿` is
 *   `[yi1 dian3 r5]`, three and three, and zips.
 * - **`xx5`**, CC-CEDICT's no-known-reading placeholder (々, ㍻, 込). **This is
 *   the one hazard that produces a silently EMPTY annotation rather than a
 *   visibly wrong one, and the one a count check cannot catch**: `xx5` is a
 *   syllable, so a one-character headword with reading `xx5` zips perfectly,
 *   would report `mode: 'aligned'`, and would render a character under a blank
 *   `<rt>`. An empty annotation reserves the ruby band and teaches nothing.
 *   `hasUnknownReading()` is therefore checked **before** the count, including
 *   the partially-unknown case, and the fallback for it carries an **empty
 *   `reading`**, which the renderer draws as *no annotation at all* — the
 *   honest statement that the dictionary has no reading here.
 * - Any entry whose syllable count simply does not equal its character count.
 *
 * **Where the readings come from, and the library not to reach for.**
 * `pinyin-pro@^3.29.3` is an installed runtime dependency whose whole purpose is
 * hanzi→pinyin per character, and it is deliberately unused at runtime:
 * `lib/dict/pinyin.ts` is hand-rolled so the same code runs in the build, the
 * server and the browser, and PLAN.md §3.4's grounding contract requires every
 * rendered reading to come from **the cited entry**, not from a second dataset
 * that might disagree with it. A fresh session that greps for a solution will
 * find `pinyin-pro` in `dependencies`; this sentence is the reason not to use
 * it. Per-character readings come from the entry's own `pinyinNum`.
 */
import { hasUnknownReading, isNumberedSyllable, markSyllable, toMarked } from '@/lib/dict/pinyin';

export interface AlignedChar {
  /** One code point of the headword. */
  char: string;
  /**
   * The marked syllable for this character, when there is one. Absent for
   * reading punctuation (`·`, `，`), which is a character with no reading
   * rather than a character whose reading is unknown.
   */
  syllable?: string;
}

export interface Alignment {
  chars: AlignedChar[];
  /**
   * `'aligned'` — every character that can carry a reading has one, and no
   * syllable was dropped. `'fallback'` — render `reading` over the whole run,
   * or nothing at all when `reading` is empty.
   */
  mode: 'aligned' | 'fallback';
  /**
   * The word-level marked reading, for the fallback. **Empty when the
   * dictionary has no reading** (`xx5`, in whole or in part) — the caller
   * renders no `<rt>` rather than an empty one.
   */
  reading: string;
}

/**
 * Characters that appear in a headword *and* in its reading and carry no
 * syllable of their own. `·` separates the parts of a transliterated name;
 * `，`/`,` separates the clauses of a proverb. Halfwidth and fullwidth forms of
 * both are listed because CC-CEDICT mixes them between the two columns.
 */
const READING_PUNCTUATION = new Set(['·', '‧', '・', ',', '，', '、']);

export function isReadingPunctuation(char: string): boolean {
  return READING_PUNCTUATION.has(char);
}

/** A token that is punctuation rather than a syllable or a Latin run. */
function isPunctuationToken(token: string): boolean {
  return isReadingPunctuation(token);
}

/**
 * A token that stands for exactly one character: a numbered syllable (`da3`,
 * `r5`) or a bare Latin run CC-CEDICT writes one-per-letter (`C`, `O`, `K`).
 * Anything else — a multi-letter Latin token, something unparseable — makes the
 * alignment refuse rather than guess which character it belongs to.
 */
function isSingleCharacterToken(token: string): boolean {
  return isNumberedSyllable(token) || /^[A-Za-z0-9]$/.test(token);
}

function fallback(headword: string, reading: string): Alignment {
  return { chars: [...headword].map((char) => ({ char })), mode: 'fallback', reading };
}

/**
 * Align a headword against its numbered reading.
 *
 * Greedy, character by character, skipping punctuation on both sides. Returns
 * `mode: 'fallback'` the moment the two sides stop agreeing — there is no
 * partial alignment, because half a correctly annotated word and half a wrongly
 * annotated one is indistinguishable to the learner from a fully correct one.
 */
export function alignReading(headword: string, pinyinNum: string): Alignment {
  const word = headword ?? '';
  const numbered = (pinyinNum ?? '').trim();

  // Before the count check, and this ordering is the point — see the header.
  if (numbered.length === 0) return fallback(word, '');
  if (hasUnknownReading(numbered)) return fallback(word, '');

  const marked = toMarked(numbered);
  const tokens = numbered.split(/\s+/).filter(Boolean);
  const chars = [...word];
  if (chars.length === 0) return fallback(word, marked);

  const out: AlignedChar[] = [];
  let t = 0;

  for (const char of chars) {
    if (isReadingPunctuation(char)) {
      // The reading usually carries the same separator; consume it when it is
      // there, and do not insist, because the two columns are not always
      // punctuated identically.
      if (t < tokens.length && isPunctuationToken(tokens[t])) t += 1;
      out.push({ char });
      continue;
    }
    // A separator the headword does not repeat (a `,` in the reading of a
    // proverb written without one) is skipped rather than mis-assigned.
    while (t < tokens.length && isPunctuationToken(tokens[t])) t += 1;
    if (t >= tokens.length) return fallback(word, marked);
    const token = tokens[t];
    if (!isSingleCharacterToken(token)) return fallback(word, marked);
    const syllable = markSyllable(token);
    // `markSyllable` returns '' only for `xx5`, which the guard above already
    // caught — but a future token shape that produced one must not become a
    // blank `<rt>` by default.
    if (syllable.length === 0) return fallback(word, marked);
    out.push({ char, syllable });
    t += 1;
  }

  while (t < tokens.length && isPunctuationToken(tokens[t])) t += 1;
  // A syllable with no character to sit under means the two sides disagree.
  if (t !== tokens.length) return fallback(word, marked);

  return { chars: out, mode: 'aligned', reading: marked };
}
