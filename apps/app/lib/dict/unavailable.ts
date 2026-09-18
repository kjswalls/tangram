/**
 * "The dictionary is not on this device yet", named once (docs/plans/web.md W6,
 * part 2).
 *
 * **Why this file exists.** The same fact reached three tabs in three different
 * shapes: a red line inside the Today card on Look up, a red line under the
 * empty state on Practice, and — on Library — a bare lowercase fragment floating
 * between the New list card and the lists, with no sentence around it and no way
 * to act on it. 1,941 unit tests and 282 e2e specs passed with all three
 * present, because they assert presence and not sense.
 *
 * The three screens could not tell that their `error` string *was* this fact,
 * because by the time it reaches them it is a string: `lib/stores/lists.ts` and
 * `lib/stores/review.ts` both flatten a caught error to `error.message`, and
 * `lib/lists/today.ts` does the same for `drawError`. So the fact is carried two
 * ways and this module owns both — a class for the throw site, and a predicate
 * that recognises either the class or the flattened message.
 *
 * `DictUnavailableError.message` IS `DICT_UNAVAILABLE_MESSAGE`, and
 * `tests/unit/dict/unavailable.test.ts` asserts it, so the string cannot drift
 * away from the predicate that recognises it.
 *
 * **What none of this decides is what the learner reads.** The screens render
 * the dictionary's own surface — `components/dict/dict-notice.tsx`'s
 * `<DictStatusView>`, the card with the size and the button — rather than a
 * sentence any of them writes. The wording is the owner's; this file is
 * plumbing.
 */

/**
 * The message `openDictStore()` rejects with. Lowercase and fragmentary on
 * purpose: it is an `Error.message`, meant to be read in a stack trace or
 * composed into a sentence, and the fact that it reached three screens verbatim
 * is the defect, not the phrasing.
 */
export const DICT_UNAVAILABLE_MESSAGE = 'the dictionary is not on this device yet';

export class DictUnavailableError extends Error {
  override readonly name = 'DictUnavailableError';

  constructor(options?: ErrorOptions) {
    super(DICT_UNAVAILABLE_MESSAGE, options);
  }
}

/**
 * Is this failure "there is no dictionary here"?
 *
 * Takes an `unknown` (a caught error), an `Error`, or the bare string a store
 * flattened it to, because all three shapes exist on the way to a screen. A
 * `name` check comes first so that a subclass or a re-thrown cause is
 * recognised without depending on the text; the text is the fallback for the
 * flattened case.
 */
export function isDictUnavailable(value: unknown): boolean {
  if (value instanceof Error) {
    return value.name === 'DictUnavailableError' || value.message === DICT_UNAVAILABLE_MESSAGE;
  }
  return typeof value === 'string' && value === DICT_UNAVAILABLE_MESSAGE;
}
