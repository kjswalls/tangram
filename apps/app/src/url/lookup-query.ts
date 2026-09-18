'use client';

/**
 * `?q=` — the lookup query, in the URL (docs/plans/web.md W8).
 *
 * **The URL is the shared state.** W8's reason is that the tab shell and the
 * palette that may one day exist are then two views of one source of truth, and
 * that a screen genuinely cannot tell which shell it is in — the thing
 * `core.md` C7's enforcement rule bought. The reason a learner notices is
 * smaller and more immediate: a lookup can be linked, bookmarked and reloaded,
 * and Back undoes a search instead of leaving the app.
 *
 * **This is the typed wrapper STACK §2.3 names.** That section records that
 * TanStack Router's typed search params would be nicer for exactly this and
 * that it was not chosen; "plain `useSearchParams` with a small typed wrapper"
 * is the compromise it settles on. So the parameter's name, its cap and its
 * canonical form live here and nothing else spells `'q'`.
 *
 * ## Why this is a sync rather than the state itself
 *
 * `lib/stores/lookup.ts` owns the query, and it has to: a reader tap calls
 * `openLookup()` from a component that is not on this route, and
 * `components/lookup/**` is reachable from `components/screens/**`, which C7
 * forbids to import the router at all. So the store stays the thing the view
 * reads and this module keeps the two in step from the route module, which is
 * allowed to know about both. `tests/unit/shell/screens-are-portable.test.ts`
 * is what would catch the shortcut.
 *
 * ## The four rules that keep it from looping, wiping or fighting the scroll
 *
 * 1. **One agreed value.** `synced` holds what the URL and the store last
 *    agreed on. Each direction writes it before it writes the other side, so
 *    the echo is recognised and dropped rather than bouncing.
 * 2. **`preventScrollReset`.** React Router's `<ScrollRestoration>` scrolls to
 *    the top on every navigation that is not a POP with a saved position — and
 *    a `?q=` write *is* a navigation. Without this, the page jumped to the top
 *    on every keystroke. Read `useScrollRestoration` in `react-router@8.3.1`
 *    before changing it; the reset is a layout effect keyed on `location`.
 * 3. **A refinement replaces; anything else pushes.** A history entry per
 *    keystroke makes Back useless; never pushing makes Back skip the search
 *    entirely. A refinement is precisely *one query is a prefix of the other
 *    and neither is empty* — `打` → `打算` is the same search still being
 *    typed, and so is a backspace. Everything else is a new search and gets its
 *    own entry, so Back walks back through `打算`, `好`, `喜欢` one at a time.
 *    The first version pushed only when the URL had no `q` at all, which
 *    collapsed three searches into one entry and made this module's own promise
 *    — "Back undoes a search" — true of the last one only. Found by W8a's
 *    adversarial review.
 * 4. **The mount is its own case, and it has to be.** Two situations arrive at
 *    the same moment and want opposite things: a shared link (`/?q=打算` on a
 *    cold load — the URL has a word, the box is empty) and a return to the tab
 *    (the box still holds the last search, the URL does not, because a tab link
 *    carries no query). An "if they differ, the URL wins" rule opens the first
 *    and **wipes the box** in the second; seeding `synced` from the URL fixes
 *    the second and makes the first do nothing at all, which is the whole
 *    feature. So: on mount, whichever side has something wins, and the URL wins
 *    a tie — a link somebody sent must beat whatever the box was holding.
 *    `synced` starts `null` to mark "not reconciled yet", because there is no
 *    string that means it.
 */
import { useEffect, useRef } from 'react';

import { useSearchParams, type SetURLSearchParams } from 'react-router';

import { useLookupStore } from '@/lib/stores/lookup';

export const LOOKUP_QUERY_PARAM = 'q';

/**
 * A cap, because the URL is written from a text box.
 *
 * Long enough for any headword, any pinyin string and a pasted sentence — the
 * ask panel takes whole questions — and short enough that nothing can push a
 * URL past what a browser, a bookmark or a share sheet will carry.
 */
export const MAX_LOOKUP_QUERY_LENGTH = 200;

/** What the URL will hold for a given box contents. Whitespace alone is nothing. */
export function canonicalLookupQuery(query: string): string {
  return query.trim() === '' ? '' : query.slice(0, MAX_LOOKUP_QUERY_LENGTH);
}

export function readLookupQuery(params: URLSearchParams): string {
  return canonicalLookupQuery(params.get(LOOKUP_QUERY_PARAM) ?? '');
}

/** The same params with `q` set, or dropped when there is nothing to look up. */
export function writeLookupQuery(params: URLSearchParams, query: string): URLSearchParams {
  const next = new URLSearchParams(params);
  const value = canonicalLookupQuery(query);
  if (value === '') next.delete(LOOKUP_QUERY_PARAM);
  else next.set(LOOKUP_QUERY_PARAM, value);
  return next;
}

/** One query is the other, still being typed. Neither may be empty. */
function isRefinement(before: string, after: string): boolean {
  if (before === '' || after === '') return false;
  return before.startsWith(after) || after.startsWith(before);
}

/**
 * Push a history entry, or replace the current one — rule 3 above.
 *
 * `restoring` is the one case that is neither: arriving on the tab with a query
 * already in the box (the learner was here earlier, or a reader tap filled it)
 * and no `q` in the URL. That write is bookkeeping, not a search somebody just
 * started, so it must not leave a history entry behind for Back to land on.
 */
export function lookupWriteMode(input: {
  urlQuery: string;
  next: string;
  first: boolean;
  restoring: boolean;
}): 'push' | 'replace' {
  if (input.first && input.restoring) return 'replace';
  return isRefinement(input.urlQuery, input.next) ? 'replace' : 'push';
}

/**
 * Long enough that a fast typist writes one URL per word.
 *
 * Deliberately a beat longer than `lookup-view.tsx`'s own 200 ms search
 * debounce: the search is what the learner is waiting for and the URL is not,
 * so the address bar settles after the results rather than racing them.
 */
export const URL_DEBOUNCE_MS = 300;

/**
 * Keep `?q=` and the lookup store in step, for as long as this is mounted.
 *
 * Mounted by the Look up route module only. `/read` has a lookup panel too, but
 * it is a panel over a passage rather than a search box, and a `?q=` there
 * would describe neither the text being read nor the word that was tapped.
 */
export function LookupQueryUrl() {
  const [params, setParams] = useSearchParams();
  const urlQuery = readLookupQuery(params);
  const storeQuery = useLookupStore((state) => state.query);
  const setQuery = useLookupStore((state) => state.setQuery);

  /** `null` until the mount case below has run. See rule 4. */
  const synced = useRef<string | null>(null);
  const first = useRef(true);
  /**
   * What was in the box at mount, when the URL had no `q` — and `null` when
   * there is nothing to restore.
   *
   * The value rather than a flag, because the flag outlived its case: a learner
   * who returns to the tab and retypes inside the 300 ms before the restoring
   * write lands would have had their *real* search written as a replace, so
   * Back left the app instead of returning to the empty page. Found by W8a's
   * adversarial review. Comparing the value closes it — the restore is only
   * ever the thing that was actually being restored.
   */
  const restoring = useRef<string | null>(null);
  // Through a ref: `useSearchParams` hands back a fresh setter whenever the
  // router's navigate identity changes, and a debounce that restarts on every
  // render is a debounce that never fires.
  const write = useRef<SetURLSearchParams>(setParams);
  useEffect(() => {
    write.current = setParams;
  });

  // The URL wins: a shared link, a reload, a Back press. Declared before the
  // other direction so that on mount it reconciles first — the write below is
  // behind a timer and re-runs on the render the store update causes anyway.
  useEffect(() => {
    if (synced.current === null) {
      // Rule 4. Read the store directly rather than through the render's
      // `storeQuery`: this runs once, and what it needs is the value now.
      const inTheBox = canonicalLookupQuery(useLookupStore.getState().query);
      if (urlQuery !== '') {
        synced.current = urlQuery;
        setQuery(urlQuery);
      } else {
        // The URL agrees on nothing, which is the literal truth: there is no
        // `q` in it. The other direction then writes the box back into it, and
        // `restoring` is what tells it to do so without a history entry.
        synced.current = '';
        restoring.current = inTheBox === '' ? null : inTheBox;
      }
      return;
    }
    if (urlQuery === synced.current) return;
    synced.current = urlQuery;
    setQuery(urlQuery);
  }, [urlQuery, setQuery]);

  // …and the box catches up to it, a beat after the typing stops.
  useEffect(() => {
    // Declared second, so on mount the effect above has already reconciled and
    // this is never the side that decides. The guard is belt and braces: a
    // write before the mount case has run would be a write of a value nothing
    // has agreed on yet.
    if (synced.current === null) return;
    if (canonicalLookupQuery(storeQuery) === synced.current) return;
    const timer = setTimeout(() => {
      // Re-read rather than close over this render's value. 300 ms is long
      // enough for the reconciliation above to have changed the answer — on a
      // shared link it does, in the same commit — and writing a value the store
      // has already moved past is how a URL ends up describing a box nobody is
      // looking at.
      const agreed = synced.current;
      const next = canonicalLookupQuery(useLookupStore.getState().query);
      if (agreed === null || next === agreed) return;
      const mode = lookupWriteMode({
        urlQuery: agreed,
        next,
        first: first.current,
        restoring: restoring.current !== null && restoring.current === next,
      });
      first.current = false;
      synced.current = next;
      write.current((current) => writeLookupQuery(current, next), {
        replace: mode === 'replace',
        preventScrollReset: true,
      });
    }, URL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [storeQuery]);

  return null;
}
