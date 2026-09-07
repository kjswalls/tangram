'use client';

/**
 * Lookup store. `openLookup()` is the front door — the reader, the ask panel and
 * the lists view all reach the lookup panel through it, carrying provenance.
 *
 * Phase 1 fills in the search state: the query, the page of grouped results, and
 * which headword the panel is showing. Everything a caller from another route
 * needs is still `openLookup({query, context})`; the rest is set by the view.
 *
 * The store is a module singleton on purpose — a reader tap sets the query here
 * and navigates, and the view picks it up on mount.
 */

import { create } from 'zustand';

import type { SearchGroup, SearchResult, SearchSection } from '@/lib/dict/search';
import type { CardContext, Entry, LookupRequest } from '@/lib/types';

export interface LookupState {
  query: string;
  context?: CardContext;
  open: boolean;
  loading: boolean;
  results: Entry[];
  error?: string;
  /** The current page of results, grouped by headword. */
  groups: SearchGroup[];
  /** The same groups, split into the labelled sections the router produced. */
  sections: SearchSection[];
  /** Groups matched before the 50-per-page cap. */
  total: number;
  /**
   * The query the results on screen answer. It lags `query` while a request is in
   * flight, which is what lets the view say whether it is showing the current
   * search or the previous one.
   */
  resultQuery: string;
  /** Pass to the next `search()` for "show more". Absent on the last page. */
  nextCursor?: string;
  /** The CC-CEDICT snapshot the results came from; stamped onto new cards. */
  dictVersion?: string;
  /** `SearchGroup.key` of the headword the panel is showing. */
  selectedKey?: string;
  /** Open the panel on a query, carrying where the query came from. */
  openLookup: (request: LookupRequest) => void;
  setQuery: (query: string) => void;
  setResults: (results: Entry[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error?: string) => void;
  /** Replace the results with a fresh first page. */
  setSearch: (result: SearchResult) => void;
  /** Append a "show more" page to the results already on screen. */
  appendSearch: (result: SearchResult) => void;
  /** Show a headword in the panel, or nothing when passed `undefined`. */
  select: (key?: string) => void;
  /** Drop the results — what an emptied search box means. */
  clearSearch: () => void;
  closeLookup: () => void;
}

const EMPTY = {
  results: [] as Entry[],
  groups: [] as SearchGroup[],
  sections: [] as SearchSection[],
  total: 0,
  resultQuery: '',
  nextCursor: undefined,
  selectedKey: undefined,
};

/** The entries behind a page of groups, matched readings first — `results` in flat form. */
function flatten(groups: SearchGroup[]): Entry[] {
  return groups.flatMap((group) => group.entries);
}

export const useLookupStore = create<LookupState>((set) => ({
  query: '',
  context: undefined,
  open: false,
  loading: false,
  error: undefined,
  ...EMPTY,
  dictVersion: undefined,
  openLookup: ({ query, context }) =>
    set({ query, context, open: true, error: undefined, ...EMPTY }),
  setQuery: (query) =>
    // A new query invalidates the selection: the panel must never show a headword
    // that is no longer in the list under it.
    set((state) => (state.query === query ? state : { query, selectedKey: undefined })),
  setResults: (results) => set({ results, loading: false }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  setSearch: (result) =>
    set({
      loading: false,
      error: undefined,
      groups: result.groups,
      sections: result.sections,
      results: flatten(result.groups),
      total: result.total,
      resultQuery: result.query,
      nextCursor: result.nextCursor,
      dictVersion: result.dictVersion,
      selectedKey: undefined,
    }),
  appendSearch: (result) =>
    set((state) => {
      const groups = [...state.groups, ...result.groups];
      const bySource = new Map(state.sections.map((part) => [part.source, part]));
      for (const part of result.sections) {
        const existing = bySource.get(part.source);
        if (existing) bySource.set(part.source, { ...existing, groups: [...existing.groups, ...part.groups] });
        else bySource.set(part.source, part);
      }
      return {
        loading: false,
        error: undefined,
        groups,
        sections: [...bySource.values()],
        results: flatten(groups),
        total: result.total,
        resultQuery: result.query,
        nextCursor: result.nextCursor,
        dictVersion: result.dictVersion,
      };
    }),
  select: (key) => set({ selectedKey: key, open: true }),
  clearSearch: () => set({ loading: false, error: undefined, ...EMPTY }),
  closeLookup: () => set({ open: false, context: undefined }),
}));

/** Imperative entry point for non-React callers (reader taps, keyboard handlers). */
export function openLookup(request: LookupRequest): void {
  useLookupStore.getState().openLookup(request);
}
