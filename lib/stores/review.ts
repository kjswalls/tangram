'use client';

/**
 * The review session store (PLAN.md §3.3, §4 P2).
 *
 * The repository is imported lazily inside the actions so that importing this
 * module never opens IndexedDB (§3.3).
 *
 * The queue is re-queried from the database after every grade rather than
 * walked in memory: the schedule the grade just wrote is what decides whether
 * the card comes back, so re-reading it is the only way the session and the
 * database cannot disagree. With `enable_short_term: false` nothing returns
 * inside a session, so the queue always shortens and the session terminates.
 */

import { create } from 'zustand';

import type { CardRow, SettingsRow, StoredRating } from '@/lib/db/schema';
import { buildReviewQueue, nextDueAt, NEW_CANDIDATE_LIMIT } from '@/lib/srs/session';

export interface ReviewState {
  queue: CardRow[];
  index: number;
  revealed: boolean;
  /** The front's context peek is open (the sentence, target masked). */
  peeked: boolean;
  loading: boolean;
  /** True once a load has landed: the first shows a spinner, later ones do not. */
  loaded: boolean;
  /** Grades written this session — the left-hand half of the progress counter. */
  graded: number;
  /** A grade is in flight; the buttons and the keyboard are inert until it lands. */
  grading: boolean;
  /** The instant the queue was built, so the empty state does not drift per render. */
  now: number;
  /** When the next card comes back, for the empty state. */
  nextDue: number | null;
  settings?: SettingsRow;
  error?: string;
  current: () => CardRow | undefined;
  load: (now?: number) => Promise<void>;
  reveal: () => void;
  peek: () => void;
  grade: (rating: StoredRating, now?: number) => Promise<void>;
  next: () => void;
  reset: () => void;
}

export const useReviewStore = create<ReviewState>((set, get) => ({
  queue: [],
  index: 0,
  revealed: false,
  peeked: false,
  loading: false,
  loaded: false,
  graded: 0,
  grading: false,
  now: 0,
  nextDue: null,
  settings: undefined,
  error: undefined,

  current: () => get().queue[get().index],

  load: async (now = Date.now()) => {
    set({ loading: true, error: undefined });
    try {
      const { getRepository } = await import('@/lib/db/get-db');
      const repo = getRepository();
      const [settings, due, candidates, all] = await Promise.all([
        repo.getSettings(),
        repo.listDue(now),
        repo.newCandidates(NEW_CANDIDATE_LIMIT),
        repo.allCards(),
      ]);
      set({
        queue: buildReviewQueue({ now, settings, due, candidates }),
        settings,
        nextDue: nextDueAt(all, now),
        now,
        index: 0,
        revealed: false,
        peeked: false,
        loading: false,
        loaded: true,
      });
    } catch (error) {
      set({
        loading: false,
        loaded: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  reveal: () => set({ revealed: true }),

  peek: () => set({ peeked: true }),

  grade: async (rating, now = Date.now()) => {
    const card = get().current();
    if (!card || get().grading) return;
    set({ grading: true });
    try {
      const { getRepository } = await import('@/lib/db/get-db');
      await getRepository().grade(card.id, rating, now);
      set((state) => ({ graded: state.graded + 1 }));
      await get().load(now);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ grading: false });
    }
  },

  /** Skip forward without grading. The queue itself is untouched. */
  next: () => set((state) => ({ index: state.index + 1, revealed: false, peeked: false })),

  reset: () =>
    set({
      queue: [],
      index: 0,
      revealed: false,
      peeked: false,
      loaded: false,
      graded: 0,
      grading: false,
      nextDue: null,
      error: undefined,
    }),
}));
