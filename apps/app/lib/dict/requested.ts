/**
 * **Has this learner already asked for the dictionary on this origin?**
 *
 * One bit, in `localStorage`, and it exists because the ask is *once*. The card
 * `components/dict/dict-status.tsx` draws says "About 14 MB to download and 43
 * MB on this device, **once**", and `lib/dict/wasm-store.ts`'s eviction recovery
 * already acts on the same rule in its own words — re-downloading after an
 * eviction is right because "asking again would be asking twice for something
 * the learner has already said yes to".
 *
 * Without this bit, `openStored()` cannot tell the two situations apart, because
 * from the main thread they look identical — the probe could not open a
 * dictionary:
 *
 * - **a fresh install.** There is nothing stored and nobody has consented. The
 *   right answer is `absent`, the ask.
 * - **a learner who consented, in a tab where OPFS cannot answer.** A second tab
 *   cannot take the `opfs-sahpool` exclusive handles (the worker's own comment
 *   calls that "the common one"), and a reload can lose the same race with its
 *   own outgoing document; a private window may have no pool at all; and a
 *   download interrupted by a reload leaves nothing associated in the pool. In
 *   every one of those the artifact is either there and unreadable *from here*
 *   or was already paid for, and showing the ask again is both wrong and a
 *   regression against what the app did before the ask existed.
 *
 * So: `download()` writes it, and a failed probe reads it to decide between the
 * ask and a full open. The bit is **per origin**, which is the right scope —
 * consent is not a property of a file that eviction can delete.
 *
 * `localStorage` rather than Dexie for the same reasons `lib/srs/direction-prefs.ts`
 * and `lib/fsrs-optimize/previous.ts` use it: it is synchronous (this is read on
 * the path that decides what the first frame shows), it is not learner data that
 * a later sync should carry, and `lib/db/repository.ts` is a frozen surface a
 * new field cannot be added to (CLAUDE.md, "Shared surfaces").
 *
 * Every access is guarded. A `localStorage` that is absent (SSR, a worker) or
 * that throws (Safari with cookies blocked) means "no record", which is the
 * conservative answer: it asks.
 */
const KEY = 'tangram.dict.requested';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Has a learner pressed "Get it" — or accepted it any other way — on this origin? */
export function dictionaryRequested(): boolean {
  try {
    return storage()?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Record the ask as answered. Called by the full open, never by the probe. */
export function rememberDictionaryRequest(): void {
  try {
    storage()?.setItem(KEY, '1');
  } catch {
    // A browser that will not remember is one that asks again. Not worth a crash.
  }
}

/** Tests, and anything that wants the app back to a first-run state. */
export function forgetDictionaryRequest(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // As above.
  }
}
