'use client';

import { useCallback, useEffect, useMemo } from 'react';

import { GradeBar } from '@/components/review/grade-bar';
import { ReviewCard } from '@/components/review/review-card';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DEFAULT_SETTINGS, type StoredRating } from '@/lib/db/schema';
import { emptyStateMessage, gradeOptions, isRevealKey, ratingFromKey } from '@/lib/srs/session';
import { useReviewStore } from '@/lib/stores/review';

/**
 * The review session (PLAN.md §4, P2).
 *
 * Space or Enter flips the card; 1–4 grade it; every other key is ignored. The
 * queue is re-read from the database after each grade (see the store), so what
 * is offered next always matches what was just written.
 */
export function ReviewSession() {
  const queue = useReviewStore((state) => state.queue);
  const index = useReviewStore((state) => state.index);
  const revealed = useReviewStore((state) => state.revealed);
  const peeked = useReviewStore((state) => state.peeked);
  const loaded = useReviewStore((state) => state.loaded);
  const graded = useReviewStore((state) => state.graded);
  const grading = useReviewStore((state) => state.grading);
  const now = useReviewStore((state) => state.now);
  const nextDue = useReviewStore((state) => state.nextDue);
  const settings = useReviewStore((state) => state.settings);
  const error = useReviewStore((state) => state.error);
  const load = useReviewStore((state) => state.load);
  const reveal = useReviewStore((state) => state.reveal);
  const peek = useReviewStore((state) => state.peek);
  const grade = useReviewStore((state) => state.grade);
  const reset = useReviewStore((state) => state.reset);

  useEffect(() => {
    void load();
    // Leaving the route ends the session: the counter is per-session, and the
    // next visit must re-read the queue rather than resume a stale one.
    return () => reset();
  }, [load, reset]);

  const card = queue[index];
  const script = settings?.script ?? DEFAULT_SETTINGS.script;

  // The intervals are computed against the same instant the queue was built —
  // `store.now`, set by `load()` before `loaded` flips — so the four labels do
  // not drift while the card sits on screen, and render stays pure.
  const options = useMemo(
    () => (card ? gradeOptions(card.fsrs, now) : []),
    [card, now],
  );

  const onGrade = useCallback(
    (rating: StoredRating) => {
      void grade(rating);
    },
    [grade],
  );

  useEffect(() => {
    if (!card) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

      if (!revealed) {
        if (!isRevealKey(event.key)) return;
        event.preventDefault();
        reveal();
        return;
      }

      const rating = ratingFromKey(event.key);
      if (rating === null) return;
      event.preventDefault();
      if (grading) return;
      void grade(rating);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [card, revealed, grading, reveal, grade]);

  if (!loaded) {
    return (
      <Card>
        <p data-testid="review-loading" className="text-sm text-muted">
          Loading your queue…
        </p>
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="Session">
        <p data-testid="review-error" className="text-sm text-warning">
          {error}
        </p>
      </Card>
    );
  }

  if (!card) {
    return (
      <Card
        title="Session"
        aside={graded > 0 ? <span className="text-sm text-muted">{graded} graded</span> : null}
      >
        <p data-testid="review-empty" className="text-base">
          {emptyStateMessage(nextDue, now)}
        </p>
      </Card>
    );
  }

  const remaining = queue.length - index;

  return (
    <div data-testid="review-session" className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <p data-testid="review-progress" className="text-sm text-muted">
          Card {graded + 1} of {graded + remaining}
        </p>
        <p className="text-xs text-muted">
          {revealed ? '1–4 to grade' : 'Space to flip'}
        </p>
      </div>

      <ReviewCard
        card={card}
        script={script}
        revealed={revealed}
        peeked={peeked}
        onPeek={peek}
        onReveal={reveal}
      />

      {revealed ? (
        <GradeBar options={options} disabled={grading} onGrade={onGrade} />
      ) : (
        <Button data-testid="reveal" size="lg" className="w-full" onClick={reveal}>
          Show answer
        </Button>
      )}
    </div>
  );
}
