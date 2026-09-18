/**
 * The list importer's resolution limits (`wave-zero.md` §8b).
 *
 * These live here and not in `lib/dict/store.ts` because that module is a
 * **types-only** surface — `tests/unit/dict/store-contract.test.ts` asserts it
 * emits nothing at runtime, so that importing the dictionary's contract can
 * never pull code into a browser bundle. Two `export const`s were enough to
 * break it, and the test caught them.
 *
 * They are carried over from `main`'s `abe6793` unchanged. A port that picks
 * its own numbers silently changes how a large paste is batched, which is why
 * they are settled in the declaration commit rather than left to the phase.
 *
 * The rest of this module is the resolution **rule**, ported from `abe6793`
 * with the index taken out of it (`wave-zero.md` §8a's table): everything here
 * is pure, so the rule can be tested without a 43 MB file, and
 * `SqliteDictStore.resolve` is the SQL that executes the plan it produces.
 */
import { hasCjk } from './rank';
import { normalizePinyin } from './pinyin';
import type { ResolveVia } from './store';

/** The most words one `DictStore.resolve` call takes; a Pleco export is chunked to fit. */
export const RESOLVE_MAX_WORDS = 1000;

/** Nothing longer is one word. Mirrors the search query cap. */
export const RESOLVE_MAX_WORD_CHARS = 200;

/**
 * Over a cap is the **caller's** error, not a truncation.
 *
 * `wave-zero.md` §8b says so and the reason is worth keeping in the type: a
 * `resolve` that silently answered about the first thousand words of a longer
 * paste would produce an import that quietly dropped the rest, and the learner
 * would find out by counting. The importer chunks to fit (`RESOLVE_CHUNK` in
 * `lib/lists/import/resolve.ts`); anything that does not, hears about it.
 */
export class ResolveLimitError extends RangeError {
  /** Which cap was passed, so a caller can say something useful. */
  readonly limit: 'words' | 'word-chars';

  constructor(limit: 'words' | 'word-chars', message: string) {
    super(message);
    this.name = 'ResolveLimitError';
    this.limit = limit;
  }
}

/** Throws `ResolveLimitError` when a request is past either cap. */
export function checkResolveLimits(words: readonly string[]): void {
  if (words.length > RESOLVE_MAX_WORDS) {
    throw new ResolveLimitError(
      'words',
      `resolve takes at most ${RESOLVE_MAX_WORDS} words at a time, not ${words.length}`,
    );
  }
  for (const word of words) {
    if (word.length > RESOLVE_MAX_WORD_CHARS) {
      throw new ResolveLimitError(
        'word-chars',
        `no word is longer than ${RESOLVE_MAX_WORD_CHARS} characters (got ${word.length})`,
      );
    }
  }
}

/**
 * Which rule a word falls under, and the keys it needs — decided before any SQL
 * runs, and therefore testable without a 43 MB file behind it.
 *
 * This is `abe6793`'s `resolveWord` with the index taken out of it. The rule is
 * unchanged and it is the part §8a says survives the port:
 *
 *   1. anything with a hanzi in it is matched **exactly** against both scripts;
 *   2. otherwise, if it parses as pinyin, tone-exact first and toneless as the
 *      fallback;
 *   3. otherwise nothing.
 *
 * `toned` is present only when the spelling actually carried a tone, because
 * that is what decides whether the fallback is a fallback: `dasuan` has no
 * tone-exact answer to prefer, so it goes straight to the toneless key, while
 * `da3suan4` prefers its toned matches and only falls back if there are none.
 */
export interface ResolveAsk {
  /** The word as asked, trimmed — what `ResolvedWord.word` echoes back. */
  word: string;
  kind: ResolveVia;
  /** The tone-exact key, when the spelling named tones. */
  toned?: string;
  /** The toneless key. Always present on a pinyin ask; it is the fallback. */
  toneless?: string;
}

/** One ask per word, in the order asked. */
export function planResolve(words: readonly string[]): ResolveAsk[] {
  return words.map((input) => {
    const word = input.trim();
    if (!word) return { word, kind: 'none' };
    // `hasCjk` is the repository's own `CJK_PATTERN` rather than a regex
    // written for the occasion — `wave-zero.md` §10f is the entry that says
    // why, and it also records the one thing this inherits: the pattern has no
    // Extension G range, so the twelve Ext G headwords route down the pinyin
    // path and resolve to nothing. Widening it is a segmentation change and is
    // a `data.md` phase's, not this one's.
    if (hasCjk(word)) return { word, kind: 'hanzi' };

    const pinyin = normalizePinyin(word);
    if (!pinyin.fullyParsed) return { word, kind: 'none' };
    const toned = pinyin.syllables.some((syllable) => syllable.tone !== null);
    return {
      word,
      kind: 'pinyin',
      ...(toned ? { toned: pinyin.toned } : {}),
      toneless: pinyin.toneless,
    };
  });
}
