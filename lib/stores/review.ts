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
 * database cannot disagree.
 *
 * v1 could lean on that re-read always *shortening* the queue, because
 * `enable_short_term: false` meant nothing was ever scheduled inside the
 * session. Since Phase 8 `settings.shortTermSteps` defaults on, so a failed
 * card is due again in a minute or ten: the re-read can legitimately hand back
 * a card that was just graded, and the session ends when nothing is due at that
 * instant rather than because the list can only get smaller. Making that a
 * feature rather than an accident — a card that comes back mid-session, and an
 * empty state that knows it is minutes away — is Phase 8's queue work
 * (HANDOFF-prep8.md, builder A).
 *
 * The re-read goes through `loadToday` — the same call Today makes — so the two
 * routes introduce and offer the same rows whichever one is opened first.
 * Reading `listDue`/`newCandidates` here instead made `/review` a dead end on a
 * fresh database ("no cards are scheduled yet") while `/` was holding ten new
 * words for the same learner, and made the demo show seven cards or fourteen
 * depending on the order the two pages were visited. Introducing on `/review`
 * spends the day's allowance exactly as opening Today does (§3.3).
 */

import { create } from 'zustand';

import type { CardRow, SettingsRow, StoredRating } from '@/lib/db/schema';
import { loadToday } from '@/lib/lists/today';
import { spaceDirections } from '@/lib/srs/direction';
import { nextDueAt } from '@/lib/srs/session';

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
  /**
   * New words today's cap still allows that could not be created — a dictionary
   * outage, since the load introduces them otherwise. The empty state says so
   * rather than claiming nothing is waiting.
   */
  waiting: number;
  /** The draw could not reach the dictionary; the due cards are still true. */
  drawError?: string;
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
  waiting: 0,
  drawError: undefined,
  settings: undefined,
  error: undefined,

  current: () => get().queue[get().index],

  load: async (now = Date.now()) => {
    set({ loading: true, error: undefined });
    try {
      const { getRepository } = await import('@/lib/db/get-db');
      const repo = getRepository();
      const summary = await loadToday({ repo, now });
      const all = await repo.allCards();
      set({
        // The queue as `buildQueue` ordered it, with one adjustment that is not
        // the queue's business: a word's two directions are never shown back to
        // back (Phase 8, `lib/srs/direction.ts`). Recognition immediately
        // followed by production of the same word is not a test of the second
        // memory — the answer is on the back of the card just graded.
        queue: spaceDirections(summary.queue.cards),
        settings: summary.settings,
        nextDue: nextDueAt(all, now),
        waiting: summary.queue.draws.length,
        ...(summary.drawError === undefined ? {} : { drawError: summary.drawError }),
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
      waiting: 0,
      drawError: undefined,
      error: undefined,
    }),
}));
