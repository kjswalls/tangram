'use client';

/**
 * Review session store. Phase 2 owns the session logic; Phase 0 owns the shape.
 *
 * The repository is imported lazily inside the actions so that importing this
 * module never opens IndexedDB (§3.3).
 */

import { create } from 'zustand';

import type { CardRow, StoredRating } from '@/lib/db/schema';

export interface ReviewState {
  queue: CardRow[];
  index: number;
  revealed: boolean;
  loading: boolean;
  error?: string;
  current: () => CardRow | undefined;
  load: (now?: number) => Promise<void>;
  reveal: () => void;
  grade: (rating: StoredRating, now?: number) => Promise<void>;
  next: () => void;
  reset: () => void;
}

export const useReviewStore = create<ReviewState>((set, get) => ({
  queue: [],
  index: 0,
  revealed: false,
  loading: false,
  error: undefined,
  current: () => get().queue[get().index],
  load: async (now = Date.now()) => {
    set({ loading: true, error: undefined });
    try {
      const { getRepository } = await import('@/lib/db/get-db');
      const queue = await getRepository().listDue(now);
      set({ queue, index: 0, revealed: false, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },
  reveal: () => set({ revealed: true }),
  grade: async (rating, now = Date.now()) => {
    const card = get().current();
    if (!card) return;
    const { getRepository } = await import('@/lib/db/get-db');
    await getRepository().grade(card.id, rating, now);
    get().next();
  },
  next: () => set((state) => ({ index: state.index + 1, revealed: false })),
  reset: () => set({ queue: [], index: 0, revealed: false, error: undefined }),
}));
