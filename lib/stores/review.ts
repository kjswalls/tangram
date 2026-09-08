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
 * (HANDOFF.md, Phase 8 prep).
 *
 * Two things make that safe rather than merely true (Phase 8, builder A):
 * `repeats` counts the grades this session has written per card, and a card
 * that reaches `MAX_SESSION_REPEATS` is set aside for the rest of the session.
 * The session therefore always terminates — every card can be served at most a
 * fixed number of times and no new ones appear — and `deferred` is surfaced
 * rather than hidden, because a queue that quietly drops a card the learner is
 * struggling with is a queue that lies.
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
import {
  deferredCardIds,
  nextDueAt,
  returningWithin,
  sessionQueue,
  SESSION_RETURN_HORIZON_MS,
} from '@/lib/srs/session';

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
  /** How many cards come back inside `SESSION_RETURN_HORIZON_MS`. */
  returning: number;
  /**
   * Grades written this session, per card. Not persisted: leaving and coming
   * back is the learner deciding to try again.
   */
  repeats: Record<string, number>;
  /** Cards set aside this session after `MAX_SESSION_REPEATS` tries. */
  deferred: string[];
  /** How many times the card on screen has been graded this session. */
  attempts: number;
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
  returning: 0,
  repeats: {},
  deferred: [],
  attempts: 0,
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
      // The set-aside cards are filtered out of the queue *and* out of every
      // number the empty state quotes, so "next card in 9 minutes" can never
      // name a card this session has stopped offering.
      const repeats = get().repeats;
      const deferred = deferredCardIds(repeats);
      // Both Phase 8 queue rules, in the one order that keeps both true.
      // `sessionQueue` drops the cards this session has set aside; only then is
      // the order adjusted, because spacing a list and *then* removing rows from
      // it can put a word's two directions back to back — the very thing the
      // spacing exists to prevent. Recognition immediately followed by
      // production of the same word is not a test of the second memory: the
      // answer is sitting on the back of the card just graded.
      const queue = spaceDirections(sessionQueue(summary.queue.cards, deferred));
      set({
        queue,
        settings: summary.settings,
        nextDue: nextDueAt(all, now, deferred),
        returning: returningWithin(all, now, SESSION_RETURN_HORIZON_MS, deferred),
        deferred: [...deferred],
        attempts: queue[0] ? (repeats[queue[0].id] ?? 0) : 0,
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
      // Counted before the re-read, so a card that has just spent its last try
      // is already set aside by the time the next queue is built.
      set((state) => ({
        graded: state.graded + 1,
        repeats: { ...state.repeats, [card.id]: (state.repeats[card.id] ?? 0) + 1 },
      }));
      await get().load(now);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ grading: false });
    }
  },

  /** Skip forward without grading. The queue itself is untouched. */
  next: () =>
    set((state) => {
      const index = state.index + 1;
      const card = state.queue[index];
      return {
        index,
        revealed: false,
        peeked: false,
        attempts: card ? (state.repeats[card.id] ?? 0) : 0,
      };
    }),

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
      returning: 0,
      repeats: {},
      deferred: [],
      attempts: 0,
      waiting: 0,
      drawError: undefined,
      error: undefined,
    }),
}));
