'use client';

/**
 * The lookup route: one input, results grouped by headword, and the panel.
 *
 * "One input, no mode picker" (PLAN.md §1) means the routing decision lives on the
 * server in `lib/dict/search.ts` and the view never asks the learner what kind of
 * thing they typed. What it does show is *which* index answered, per result, so a
 * surprising hit is explainable rather than mysterious.
 *
 * The ask panel is `LookupPanel`'s own default content for its ask region (P4's
 * one sanctioned edit to that file); `askSlot` stays here as the override hook
 * for a caller that wants something else there. Either way the dictionary body
 * renders and stays usable whatever the provider is doing (§3.4).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { EntryDetail } from '@/components/lookup/entry-detail';
import { SearchResults } from '@/components/lookup/search-results';
import { LookupPanel } from '@/components/lookup/lookup-panel';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { getDictStore } from '@/lib/dict/browser-store';
import { useLookupStore } from '@/lib/stores/lookup';

/** Long enough that a fast typist makes one request per word, short enough to feel live. */
const DEBOUNCE_MS = 200;

/**
 * The lookup box's DOM id, exported because the keyboard model has to find it
 * (docs/plans/web.md W8): `Mod+K` and `/` mean "jump to the lookup box" from
 * anywhere, and the module that implements that may not be the one that renders
 * the box — it navigates, and `core.md` C7 forbids anything reachable from a
 * screen to know what a route is. One exported constant is the whole of the
 * coupling, and it is a string the `<label>` already had to agree with.
 */
export const LOOKUP_INPUT_ID = 'lookup-query';

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * The "dictionary data is missing" case is **not** here any more (core.md
 * C4a): it is `store.status`, and `<DictGate>` around this route draws it — a
 * message inside a search box the learner is still typing into told them
 * something was wrong and left them typing. What is left is the ordinary
 * failure of a query the store could not answer.
 */
function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Search failed. Try again.';
}

export function LookupView({ askSlot }: { askSlot?: ReactNode }) {
  const query = useLookupStore((state) => state.query);
  const context = useLookupStore((state) => state.context);
  const loading = useLookupStore((state) => state.loading);
  const error = useLookupStore((state) => state.error);
  const groups = useLookupStore((state) => state.groups);
  const sections = useLookupStore((state) => state.sections);
  const total = useLookupStore((state) => state.total);
  const resultQuery = useLookupStore((state) => state.resultQuery);
  const nextCursor = useLookupStore((state) => state.nextCursor);
  const dictVersion = useLookupStore((state) => state.dictVersion);
  const selectedKey = useLookupStore((state) => state.selectedKey);
  const setQuery = useLookupStore((state) => state.setQuery);
  const setLoading = useLookupStore((state) => state.setLoading);
  const setError = useLookupStore((state) => state.setError);
  const setSearch = useLookupStore((state) => state.setSearch);
  const appendSearch = useLookupStore((state) => state.appendSearch);
  const clearSearch = useLookupStore((state) => state.clearSearch);
  const select = useLookupStore((state) => state.select);

  const [loadingMore, setLoadingMore] = useState(false);
  /** The panel's head has been scrolled out of view since the pick (see the results column). */
  const [headAway, setHeadAway] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      clearSearch();
      return;
    }
    setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      getDictStore()
        .search(trimmed, { signal: controller.signal })
        .then(setSearch)
        .catch((cause: unknown) => {
          if (!isAbort(cause)) setError(message(cause));
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, clearSearch, setLoading, setSearch, setError]);

  const showMore = useCallback(async () => {
    const cursor = useLookupStore.getState().nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    try {
      appendSearch(await getDictStore().search(query.trim(), { cursor }));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoadingMore(false);
    }
  }, [appendSearch, query, setError]);

  const selected = groups.find((group) => group.key === selectedKey);

  // On a phone the panel sits above the list, so picking the fortieth result would
  // otherwise answer somewhere off-screen. Only scrolls when it actually is.
  // "Off-screen" means outside the band the root's scroll padding leaves clear
  // (globals.css): below the wide shell's pinned header, above the phone's tab
  // bar — the same band `scrollIntoView` honours in turn.
  //
  // **What has to be on screen is the panel's head**, not the panel. The panel
  // is routinely taller than a phone (readings, characters, the ask), and
  // `block: 'nearest'` on a box taller than the viewport that sits above it
  // aligns its *bottom* edge — the headword ended hundreds of pixels up. So the
  // check is on the header and the alignment is `start`.
  //
  // A layout effect, so the measurement and the scroll land in the frame that
  // moved the panel to the top rather than one painted frame later.
  //
  // The other half is the results column's `overflow-anchor` (below). On a
  // wide screen the panel is also its own scroller (capped to the room below
  // the header — see the panel), and a new pick starts at its top: otherwise
  // the scroll left over from reading the last answer hides the new entry's
  // headword above the panel's visible area.
  useLayoutEffect(() => {
    const node = panelRef.current;
    setHeadAway(false);
    if (!selectedKey || !node) return;
    node.scrollTop = 0;
    const head = node.querySelector('header') ?? node;
    const box = head.getBoundingClientRect();
    const root = getComputedStyle(document.documentElement);
    const top = parseFloat(root.scrollPaddingTop) || 0;
    const bottom = window.innerHeight - (parseFloat(root.scrollPaddingBottom) || 0);
    if (box.top < top || box.bottom > bottom) node.scrollIntoView({ block: 'start' });
  }, [selectedKey]);

  // Whether the learner has scrolled the panel's head away since the pick —
  // the moment the results column should take part in scroll anchoring again.
  // Observed rather than timed: it is the learner's scroll that decides.
  useEffect(() => {
    const head = panelRef.current?.querySelector('header');
    if (!selectedKey || !head || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setHeadAway(!entry.isIntersecting));
    observer.observe(head);
    return () => observer.disconnect();
  }, [selectedKey]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label htmlFor={LOOKUP_INPUT_ID} className="sr-only">
          Look up a word
        </label>
        <Input
          id={LOOKUP_INPUT_ID}
          data-testid="lookup-input"
          type="search"
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder="打算 · dasuan · dǎsuàn · plan"
          onChange={(event) => setQuery(event.target.value)}
        />
        <p className="mt-1 text-xs text-muted" data-testid="lookup-status">
          {error
            ? error
            : loading
              ? 'Searching…'
              : !query.trim()
                ? 'Tones are optional — dasuan, da3suan4 and dǎsuàn all find 打算.'
                : total === 0
                  ? 'No headword matched that — the Ask panel takes the whole question. For a single word, try fewer letters, the other script, or the English word.'
                  : ''}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/*
          **Out of scroll anchoring while the panel's head is on screen** (below
          md, with a pick). The results come first in the DOM and the panel is
          moved above them by `order`, so the browser's anchor — the first
          visible node in DOM order — was a result row drawn *under* the panel.
          Every pixel the panel then grew by (the readings, the characters, the
          ask arriving) was paid for by scrolling the page down to hold that row
          still, which pushed the headword off the top: 30–73px on `?q=the`
          (first-run audit, HANDOFF.md). With the column opted out, the anchor
          is chosen from the panel, whose head is what the learner is reading.

          Only while that head is in view. Once the learner scrolls down into
          the results, the rows are what they are reading, and a panel growing
          above them must not slide them away — so anchoring comes back.
          Wide keeps anchoring throughout: there DOM order is visual order.
        */}
        <div
          data-testid="lookup-results-column"
          data-anchoring={selected && !headAway ? 'panel' : 'results'}
          className={cn('order-2 md:order-1', selected && !headAway && 'max-md:[overflow-anchor:none]')}
        >
          <SearchResults
            sections={sections}
            total={total}
            shown={groups.length}
            resultQuery={resultQuery}
            selectedKey={selectedKey}
            onSelect={select}
            onShowMore={showMore}
            showingMore={loadingMore}
            hasMore={Boolean(nextCursor)}
          />
        </div>
        {/*
          Below md the panel leads (`order-1`) once a result is picked, which is
          right the moment there is something in it and wrong before: an empty
          card that echoes the query pushed the first hit ~200px down the screen.

          What it must never be is *hidden*. An English sentence has no headword
          to pick, so gating the whole column on a selection left a phone with
          "No matches" and nothing else — the §1 front door, the phrase card and
          "Add this sense" were all unreachable at 390px. So: hidden only when
          the box is empty, and second in the order until a result is picked.
        */}
        <div
          className={cn(
            'md:order-2',
            selected ? 'order-1' : 'order-2',
            selected || query.trim() ? '' : 'hidden md:block',
          )}
        >
          {/*
            Sticky below the pinned header, and **no taller than the room it
            sticks in**: a sticky box taller than the viewport keeps its bottom
            off screen until the column scrolls to its end, so a long answer
            was cut off exactly where the learner was reading. Capped at the
            viewport less the header and the 1rem gap above and below, it
            scrolls inside itself instead. `--shell-header-height` is zero
            whenever the header is not pinned, so the same expression holds.
            Print undoes the cap: a page is not a viewport, and a scroller
            would print only its first screenful.
          */}
          <div
            ref={panelRef}
            data-testid="lookup-panel-column"
            className="md:sticky md:top-[calc(var(--shell-header-height)+1rem)] md:max-h-[calc(100dvh-var(--shell-header-height)-2rem)] md:overflow-y-auto print:max-h-none print:overflow-visible"
          >
            <LookupPanel
              query={selected ? selected.simp : query}
              // The ask stays keyed to what the learner typed. Picking 打算 out
              // of a `dasuan` search used to re-ask about the headword, which
              // is a second provider call *and* throws away the answer being
              // read — on a phone the demo's Say-it line was never on screen.
              askQuery={query}
              context={context}
              slots={{ ask: askSlot }}
            >
              {selected ? (
                <EntryDetail
                  key={selected.key}
                  group={selected}
                  query={query}
                  context={context}
                  dictVersion={dictVersion}
                />
              ) : (
                <p className="text-sm text-muted">
                  {query.trim()
                    ? 'Pick a result to see every reading, its glosses and the characters it is built from — and to add it as a card.'
                    : 'Type a word to look it up. Anything you add keeps the query it came from on its back.'}
                </p>
              )}
            </LookupPanel>
          </div>
        </div>
      </div>
    </div>
  );
}
