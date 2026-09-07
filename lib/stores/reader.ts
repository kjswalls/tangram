'use client';

/**
 * Reader store (PLAN.md §3.5).
 *
 * Two copies of the text, on purpose. The store holds the one being read, so it
 * survives navigating to `/review` and back without a round trip; the `texts`
 * table is the durable copy you can reopen tomorrow. Losing a pasted paragraph
 * to a tap on the nav is the kind of thing that stops someone using a reader.
 *
 * Segmentation lives here rather than in the view because the tokens are part of
 * that surviving state: coming back from another route must not re-post the
 * whole paragraph to `/api/dict/segment`.
 *
 * What is *not* here: the token colours. Those are read live from IndexedDB by
 * `components/reader/use-reader-index.ts`, so an Add or a "Mark known"
 * recolours the text without anything having to remember to tell the store.
 */

import { create } from 'zustand';

import type { TextRow } from '@/lib/db/schema';
import { fetchSegment } from '@/lib/dict/client';
import type { Token } from '@/lib/types';

/** `compose` is the paste box; `read` is the reading view. */
export type ReaderView = 'compose' | 'read';

/** A span of the body: one token, or several after "Extend". */
export interface ReaderSpan {
  text: string;
  start: number;
  end: number;
  tokens: Token[];
}

export interface ReaderState {
  /** The `texts` row this text was saved as, once it has been. */
  textId?: string;
  title: string;
  body: string;
  /** The text the tokens belong to; anything else means they are stale. */
  tokenizedBody: string;
  tokens: Token[];
  /** Index into `tokens` of the token the panel is showing. */
  selected?: number;
  /** Last token of the current span — the selected one until "Extend" grows it. */
  spanEnd?: number;
  view: ReaderView;
  /** Saved texts, newest first. */
  saved: TextRow[];
  loading: boolean;
  saving: boolean;
  error?: string;

  setText: (body: string, title?: string) => void;
  setTitle: (title: string) => void;
  setTokens: (tokens: Token[], body?: string) => void;
  setView: (view: ReaderView) => void;
  setError: (error?: string) => void;
  /** Segment the current body and switch to the reading view. */
  read: () => Promise<void>;
  /** Persist the current text and remember its row id. */
  save: () => Promise<void>;
  /** Load the saved texts for the "reopen" list. */
  loadSaved: () => Promise<void>;
  /** Reopen a saved text: it becomes the current one and is segmented. */
  open: (row: TextRow) => Promise<void>;
  /** Show a token in the panel. `undefined` clears the selection. */
  select: (index?: number) => void;
  /** Extend the span over the next word token; returns the span it made. */
  extend: () => ReaderSpan | undefined;
  /** Start again with an empty paste box. The saved copies are untouched. */
  clear: () => void;
}

/** The current span in the body: the selected token, plus any extension. */
export function spanOf(
  state: Pick<ReaderState, 'tokens' | 'selected' | 'spanEnd' | 'body'>,
): ReaderSpan | undefined {
  const { tokens, selected } = state;
  if (selected === undefined) return undefined;
  const first = tokens[selected];
  if (!first) return undefined;
  const lastIndex = state.spanEnd ?? selected;
  const last = tokens[lastIndex] ?? first;
  const start = first.start;
  const end = Math.max(last.end, first.end);
  return { text: state.body.slice(start, end), start, end, tokens: tokens.slice(selected, lastIndex + 1) };
}

/** The next token after the span that could join it: a word, right next to it. */
export function nextExtendable(
  state: Pick<ReaderState, 'tokens' | 'selected' | 'spanEnd'>,
): number | undefined {
  const { tokens, selected } = state;
  if (selected === undefined) return undefined;
  const at = (state.spanEnd ?? selected) + 1;
  const token = tokens[at];
  if (!token || token.kind !== 'word') return undefined;
  // Adjacency matters: 北京。上海 is not a span, whatever the two words are.
  if (tokens[at - 1].end !== token.start) return undefined;
  return at;
}

async function repository() {
  const { getRepository } = await import('@/lib/db/get-db');
  return getRepository();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const NO_SELECTION = { selected: undefined, spanEnd: undefined };

export const useReaderStore = create<ReaderState>((set, get) => ({
  textId: undefined,
  title: '',
  body: '',
  tokenizedBody: '',
  tokens: [],
  selected: undefined,
  spanEnd: undefined,
  view: 'compose',
  saved: [],
  loading: false,
  saving: false,
  error: undefined,

  setText: (body, title) =>
    set({
      body,
      tokens: [],
      tokenizedBody: '',
      ...NO_SELECTION,
      // Editing the text makes it a different text: it saves as a new row
      // rather than overwriting the one still on the reopen list.
      textId: undefined,
      ...(title === undefined ? {} : { title }),
    }),

  setTitle: (title) => set({ title }),

  setTokens: (tokens, body) =>
    set((state) => ({ tokens, tokenizedBody: body ?? state.body, ...NO_SELECTION })),

  setView: (view) => set({ view }),

  setError: (error) => set({ error }),

  read: async () => {
    const { body, tokenizedBody, tokens } = get();
    if (!body.trim()) return;
    if (tokenizedBody === body && tokens.length > 0) {
      set({ view: 'read' });
      return;
    }
    set({ loading: true, error: undefined });
    try {
      const result = await fetchSegment(body);
      // The body can have changed while the request was out; a token list that
      // indexes a different string would highlight the wrong characters.
      if (get().body !== body) {
        set({ loading: false });
        return;
      }
      set({
        tokens: result.tokens,
        tokenizedBody: body,
        view: 'read',
        loading: false,
        ...NO_SELECTION,
      });
    } catch (error) {
      set({ loading: false, error: message(error) });
    }
  },

  save: async () => {
    const { title, body, textId } = get();
    if (!body.trim()) return;
    set({ saving: true, error: undefined });
    try {
      const repo = await repository();
      const row = await repo.saveText({
        ...(textId === undefined ? {} : { id: textId }),
        title: title.trim() || defaultTitle(body),
        body,
      });
      set({ textId: row.id, title: row.title, saving: false, saved: await repo.texts() });
    } catch (error) {
      set({ saving: false, error: message(error) });
    }
  },

  loadSaved: async () => {
    try {
      set({ saved: await (await repository()).texts() });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  open: async (row) => {
    set({
      textId: row.id,
      title: row.title,
      body: row.body,
      tokens: [],
      tokenizedBody: '',
      ...NO_SELECTION,
    });
    await get().read();
  },

  select: (index) =>
    set((state) =>
      index !== undefined && state.tokens[index]?.kind === 'word'
        ? { selected: index, spanEnd: index }
        : NO_SELECTION,
    ),

  extend: () => {
    const state = get();
    const at = nextExtendable(state);
    if (at === undefined) return undefined;
    set({ spanEnd: at });
    return spanOf({ ...state, spanEnd: at });
  },

  clear: () =>
    set({
      textId: undefined,
      title: '',
      body: '',
      tokens: [],
      tokenizedBody: '',
      ...NO_SELECTION,
      view: 'compose',
      error: undefined,
    }),
}));

/** The first line, or the first few characters — a reopen list needs a label. */
export function defaultTitle(body: string): string {
  const line = body.trim().split('\n')[0]?.trim() ?? '';
  const cut = line.slice(0, 40);
  if (!cut) return 'Untitled text';
  return cut.length < line.length ? `${cut}…` : cut;
}
