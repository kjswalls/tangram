'use client';

/**
 * Reader store. The pasted text lives here so it survives navigation; the
 * `texts` table is the durable copy (§3.5). Phase 5 fills in segmentation.
 */

import { create } from 'zustand';

import type { Token } from '@/lib/types';

export interface ReaderState {
  textId?: string;
  title: string;
  body: string;
  tokens: Token[];
  loading: boolean;
  error?: string;
  setText: (body: string, title?: string) => void;
  setTokens: (tokens: Token[]) => void;
  /** Persist the current text and remember its row id. */
  save: () => Promise<void>;
  clear: () => void;
}

export const useReaderStore = create<ReaderState>((set, get) => ({
  textId: undefined,
  title: '',
  body: '',
  tokens: [],
  loading: false,
  error: undefined,
  setText: (body, title) => set({ body, tokens: [], ...(title === undefined ? {} : { title }) }),
  setTokens: (tokens) => set({ tokens }),
  save: async () => {
    const { title, body, textId } = get();
    if (!body.trim()) return;
    const { getRepository } = await import('@/lib/db/get-db');
    const row = await getRepository().saveText({
      ...(textId === undefined ? {} : { id: textId }),
      title: title || body.slice(0, 40),
      body,
    });
    set({ textId: row.id, title: row.title });
  },
  clear: () => set({ textId: undefined, title: '', body: '', tokens: [] }),
}));
