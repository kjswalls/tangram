'use client';

/**
 * The lookup route: one input, results grouped by headword, and the panel.
 *
 * "One input, no mode picker" (PLAN.md §1) means the routing decision lives on the
 * server in `lib/dict/search.ts` and the view never asks the learner what kind of
 * thing they typed. What it does show is *which* index answered, per result, so a
 * surprising hit is explainable rather than mysterious.
 *
 * The ask panel (Phase 4) mounts through `askSlot` into the panel's `ask` slot,
 * which stays empty until then: the dictionary body must render and stay usable
 * whatever the provider is doing (§3.4).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { EntryDetail } from '@/components/lookup/entry-detail';
import { SearchResults } from '@/components/lookup/search-results';
import { LookupPanel } from '@/components/lookup/lookup-panel';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { DictRequestError, fetchSearch } from '@/lib/dict/client';
import { useLookupStore } from '@/lib/stores/lookup';

/** Long enough that a fast typist makes one request per word, short enough to feel live. */
const DEBOUNCE_MS = 200;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function message(error: unknown): string {
  if (error instanceof DictRequestError) {
    return error.dataMissing ? 'Dictionary data is missing — run pnpm data.' : error.message;
  }
  return 'Search failed. Try again.';
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
      fetchSearch(trimmed, { signal: controller.signal })
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
      appendSearch(await fetchSearch(query.trim(), { cursor }));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoadingMore(false);
    }
  }, [appendSearch, query, setError]);

  const selected = groups.find((group) => group.key === selectedKey);

  // On a phone the panel sits above the list, so picking the fortieth result would
  // otherwise answer somewhere off-screen. Only scrolls when it actually is.
  useEffect(() => {
    const node = panelRef.current;
    if (!selectedKey || !node) return;
    const box = node.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) node.scrollIntoView({ block: 'nearest' });
  }, [selectedKey]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label htmlFor="lookup-query" className="sr-only">
          Look up a word
        </label>
        <Input
          id="lookup-query"
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
                  ? 'Nothing matched. Try fewer letters, the other script, or the English word.'
                  : ''}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="order-2 md:order-1">
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
          Below md the panel is above the results (`order-1`), which is right the
          moment there is something in it and wrong before: an empty card that
          echoes the query pushed the first hit ~200px down the screen. So on a
          phone it appears when a result is picked, and the two-column sticky
          desktop layout is unchanged.
        */}
        <div className={cn('order-1 md:order-2', selected ? '' : 'hidden md:block')}>
          <div ref={panelRef} className="md:sticky md:top-4">
            <LookupPanel
              query={selected ? selected.simp : query}
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
