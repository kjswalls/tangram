/**
 * Where the importer's `Resolver` comes from in a browser (`wave-zero.md` §8a).
 *
 * `abe6793` answered this by `fetch`ing a dictionary-resolve route. That route
 * is not ported and could not be: since `data.md` D6 the client queries the
 * dictionary in-process and the app's own origin **404s the whole `/api/**`
 * prefix**, so the round trip the route existed to make is gone. What replaced
 * it is one `DictStore.resolve` call per chunk.
 *
 * (The route is named nowhere in this tree, and deliberately:
 * `tests/unit/dict/client-callers.test.ts` greps every source for a dictionary
 * route path. It caught this file's first draft, which named it in prose.)
 *
 * It is its own module rather than a line inside the component for the reason
 * `lib/lists/entry-source.ts` is: the component is then testable with a
 * hand-built map, and the one place that reaches for the app's store handle is
 * a file with no React in it.
 */
import { openDictStore } from '@/lib/dict/browser-store';

import type { Resolver } from './resolve';

/**
 * The browser's resolver.
 *
 * `openDictStore()` rather than `getDictStore()`, for `entry-source.ts`'s
 * reason: it opens what this origin already has and **fetches nothing**. The
 * importer is inside Library, which is the learner's own data and is not gated
 * (`data.md` D4), so it has nowhere to draw a progress bar and must not start a
 * 14 MB download from a button press that said "Preview". Its rejection is a
 * `DictUnavailableError`, which the component recognises rather than prints —
 * the page's one `<DictNotice>` is where that fact is said, with the button
 * that fixes it (`web.md` W6 part 2).
 */
export function getImportResolver(): Resolver {
  return async (words) => (await openDictStore()).resolve(words);
}
