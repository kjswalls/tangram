import type {
  CardRow,
  FsrsCardState,
  FsrsStateValue,
  ReviewRow,
  StoredRating,
} from '@/lib/db/schema';

export const DAY = 86_400_000;

/** A local instant well away from a DST boundary, so a fixture means one thing. */
export const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();

let counter = 0;

export function fsrsState(overrides: Partial<FsrsCardState> = {}): FsrsCardState {
  return {
    state: 2,
    due: NOW + DAY,
    stability: 10,
    difficulty: 5,
    reps: 3,
    lapses: 0,
    scheduled_days: 10,
    learning_steps: 0,
    ...overrides,
  };
}

export interface ReviewSpec {
  /** The state the card was in when it was asked. 2 is Review. */
  state?: FsrsStateValue;
  rating?: StoredRating;
  reviewedAt?: number;
  stability?: number;
  /** Days since the previous review; written into `before.last_review`. */
  elapsedDays?: number;
  /** Set to drop `last_review`, so only the stored log can answer. */
  noLastReview?: boolean;
}

export function review(spec: ReviewSpec = {}): ReviewRow {
  const reviewedAt = spec.reviewedAt ?? NOW;
  const elapsedDays = spec.elapsedDays ?? 10;
  const state = spec.state ?? 2;
  const stability = spec.stability ?? 10;
  const before = fsrsState({
    state,
    stability,
    last_review: spec.noLastReview ? undefined : reviewedAt - elapsedDays * DAY,
  });
  const rating = spec.rating ?? 3;
  return {
    id: `review-${counter++}`,
    cardId: `card-${counter}`,
    rating,
    reviewedAt,
    before,
    log: {
      rating,
      state,
      due: before.due,
      stability,
      difficulty: before.difficulty,
      elapsed_days: Math.round(elapsedDays),
      last_elapsed_days: 0,
      scheduled_days: before.scheduled_days,
      learning_steps: 0,
      review: reviewedAt,
    },
    createdAt: reviewedAt,
  };
}

export function card(overrides: Partial<CardRow> = {}): CardRow {
  const fsrs = overrides.fsrs ?? fsrsState();
  return {
    id: `card-${counter++}`,
    wordId: null,
    entryId: `entry-${counter}`,
    kind: 'word',
    direction: 'recognition',
    snapshot: {
      simp: '打算',
      trad: '打算',
      pinyinMarked: 'dǎsuàn',
      pinyinNum: 'da3 suan4',
      glosses: ['to plan'],
      classifiers: [],
      dictVersion: 'test',
    },
    fsrs,
    due: fsrs.due,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

/** A card due at `due`, in the Review state unless told otherwise. */
export function dueCard(due: number, state: FsrsStateValue = 2): CardRow {
  return card({ fsrs: fsrsState({ state, due }), due });
}
