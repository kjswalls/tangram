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
import { getDictStore } from '@/lib/dict/browser-store';
import type { Token } from '@/lib/types';

/** `compose` is the paste box; `read` is the reading view. */
export type ReaderView = 'compose' | 'read';

/** A span of the body: one token, several after "Extend", or a dragged run. */
export interface ReaderSpan {
  text: string;
  /** Character offset into `body` of the first character. */
  start: number;
  /** Character offset one past the last — `body.slice(start, end)` is `text`. */
  end: number;
  /** Every token the span overlaps, in order. */
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
  /**
   * **Character** offset into `body` of the first character of the span
   * (docs/plans/core.md C5b). It was a token index until C5b; product rules 1
   * and 2 make selection character-granular, and STACK §2.1 calls this out as a
   * rewrite of the data model rather than an addition to it.
   */
  selected?: number;
  /** Character offset of the **last** character of the span, inclusive. */
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
  /**
   * Persist the current text and remember its row id. Returns whether it was
   * saved: "Save and read" must not read past a failure, because switching to
   * the reading view unmounts the only place `error` is shown and the next
   * refresh loses the paragraph.
   */
  save: () => Promise<boolean>;
  /** Load the saved texts for the "reopen" list. */
  loadSaved: () => Promise<void>;
  /** Reopen a saved text: it becomes the current one and is segmented. */
  open: (row: TextRow) => Promise<void>;
  /**
   * Show the word token at `index` (an index into `tokens`, which is what
   * `<HanziText>` reports for a tap). `undefined` clears the selection.
   */
  selectToken: (index?: number) => void;
  /**
   * A dragged span, in **character** offsets into `body`, both inclusive.
   * Endpoints are snapped by `useSpanSelect` before they arrive here; this
   * clamps and orders them and does not second-guess which characters are
   * legal, because the snapping rule belongs with the thing that hit-tests.
   */
  selectSpan: (from: number, to: number) => void;
  /** Drop the selection. The text and the tokens are untouched. */
  clearSelection: () => void;
  /** Extend the span over the next word token; returns the span it made. */
  extend: () => ReaderSpan | undefined;
  /** Start again with an empty paste box. The saved copies are untouched. */
  clear: () => void;
}

/**
 * The token containing a character offset, or `undefined` past the end.
 *
 * Every character in the body has an index in the C5b model, including the
 * punctuation and Latin runs that carry no `data-token-index` — `spanOf()`
 * slices the body, and a span that crosses a comma has to contain the comma.
 * What the tokens still decide is what a **tap** and a span **endpoint** may
 * be, which is why this answers for every character and the callers ask
 * `kind === 'word'` themselves.
 */
export function tokenAt(tokens: readonly Token[], char: number): number | undefined {
  // Linear rather than a binary search on purpose: a 2,000-character text is
  // ~1,300 tokens and this runs once per tap, not once per pointer move.
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (char >= token.start && char < token.end) return index;
  }
  return undefined;
}

/** The current span in the body, in character offsets. */
export function spanOf(
  state: Pick<ReaderState, 'tokens' | 'selected' | 'spanEnd' | 'body'>,
): ReaderSpan | undefined {
  const { tokens, body, selected } = state;
  if (selected === undefined) return undefined;
  const start = Math.max(0, Math.min(selected, body.length));
  const end = Math.min(body.length, (state.spanEnd ?? selected) + 1);
  if (end <= start) return undefined;
  return {
    text: body.slice(start, end),
    start,
    end,
    // Overlap, not containment: a drag can start or end inside a word and the
    // word is still part of what was selected.
    tokens: tokens.filter((token) => token.start < end && token.end > start),
  };
}

/** The next token after the span that could join it: a word, right next to it. */
export function nextExtendable(
  state: Pick<ReaderState, 'tokens' | 'selected' | 'spanEnd'>,
): number | undefined {
  const { tokens, selected } = state;
  if (selected === undefined) return undefined;
  // The span's exclusive end, which is where an adjacent word would begin.
  const boundary = (state.spanEnd ?? selected) + 1;
  const at = tokens.findIndex((token) => token.start === boundary);
  if (at < 0) return undefined;
  const token = tokens[at];
  if (token.kind !== 'word') return undefined;
  // Adjacency matters: 北京。上海 is not a span, whatever the two words are.
  // The `start === boundary` match above is the whole of that test now, because
  // a `text` token between them starts at the boundary and is refused by kind.
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
      // Through `DictStore`, not a route (core.md C4a). The store is read at
      // call time rather than captured at module load so a swapped
      // implementation — D4's OPFS store, a phone's plugin — takes effect
      // without this file knowing.
      const result = await getDictStore().segment(body);
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
    if (!body.trim()) return false;
    set({ saving: true, error: undefined });
    try {
      const repo = await repository();
      const row = await repo.saveText({
        ...(textId === undefined ? {} : { id: textId }),
        title: title.trim() || defaultTitle(body),
        body,
      });
      set({ textId: row.id, title: row.title, saving: false, saved: await repo.texts() });
      return true;
    } catch (error) {
      set({ saving: false, error: message(error) });
      return false;
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

  selectToken: (index) =>
    set((state) => {
      const token = index === undefined ? undefined : state.tokens[index];
      // Only word tokens are tap targets; punctuation, Latin and whitespace are
      // valid span *interiors* and nothing else (C5b).
      if (!token || token.kind !== 'word') return NO_SELECTION;
      return { selected: token.start, spanEnd: token.end - 1 };
    }),

  selectSpan: (from, to) =>
    set((state) => {
      const limit = state.body.length - 1;
      if (limit < 0) return NO_SELECTION;
      const lo = Math.max(0, Math.min(Math.min(from, to), limit));
      const hi = Math.max(0, Math.min(Math.max(from, to), limit));
      return { selected: lo, spanEnd: hi };
    }),

  clearSelection: () => set(NO_SELECTION),

  extend: () => {
    const state = get();
    const at = nextExtendable(state);
    if (at === undefined) return undefined;
    const spanEnd = state.tokens[at].end - 1;
    set({ spanEnd });
    return spanOf({ ...state, spanEnd });
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
