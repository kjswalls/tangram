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
 * The rest of this module — the resolution rule itself — is the porting phase's
 * (`wave-zero.md` §8a's table). `abe6793`'s version read the in-heap JSON index
 * that `data.md` D1–D4 replaced; the rule survives, the implementation does not.
 */

/** The most words one `DictStore.resolve` call takes; a Pleco export is chunked to fit. */
export const RESOLVE_MAX_WORDS = 1000;

/** Nothing longer is one word. Mirrors the search query cap. */
export const RESOLVE_MAX_WORD_CHARS = 200;
