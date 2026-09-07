'use client';

/**
 * Lookup store. `openLookup()` is the front door — the reader, the ask panel and
 * the lists view all reach the lookup panel through it, carrying provenance.
 *
 * Phase 1 fills in results; Phase 0 owns the shape.
 */

import { create } from 'zustand';

import type { CardContext, Entry, LookupRequest } from '@/lib/types';

export interface LookupState {
  query: string;
  context?: CardContext;
  open: boolean;
  loading: boolean;
  results: Entry[];
  error?: string;
  /** Open the panel on a query, carrying where the query came from. */
  openLookup: (request: LookupRequest) => void;
  setQuery: (query: string) => void;
  setResults: (results: Entry[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error?: string) => void;
  closeLookup: () => void;
}

export const useLookupStore = create<LookupState>((set) => ({
  query: '',
  context: undefined,
  open: false,
  loading: false,
  results: [],
  error: undefined,
  openLookup: ({ query, context }) =>
    set({ query, context, open: true, error: undefined, results: [] }),
  setQuery: (query) => set({ query }),
  setResults: (results) => set({ results, loading: false }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  closeLookup: () => set({ open: false, context: undefined }),
}));

/** Imperative entry point for non-React callers (reader taps, keyboard handlers). */
export function openLookup(request: LookupRequest): void {
  useLookupStore.getState().openLookup(request);
}
