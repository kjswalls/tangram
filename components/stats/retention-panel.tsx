'use client';

/**
 * True retention — the one number that says whether the schedule is working
 * (Phase 8). It is the dashboard's hero figure, and the only one on the page.
 *
 * The denominator is on screen next to it, in words, because this number has a
 * famous failure mode: counting learning-step reviews alongside real ones. With
 * FSRS's learning steps on (the default since Phase 8) a new word can be
 * answered three times in ten minutes, and those answers are nearly all
 * successes — fold them in and the headline drifts up toward 95% and stops
 * moving when the schedule gets worse. So the excluded reviews are counted and
 * shown too: the two figures add up to the review log, and anyone can check.
 */

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { NotEnough, StatTile, formatCount } from '@/components/stats/primitives';
import { formatRate, type RetentionSummary } from '@/lib/stats/retention';

export interface RetentionPanelProps {
  window: RetentionSummary;
  allTime: RetentionSummary;
  windowDays: number;
}

function denominator(summary: RetentionSummary, span: string): string {
  return `${formatCount(summary.recalled)} of ${formatCount(summary.reviews)} reviews recalled — cards already in the Review state, ${span}`;
}

export function RetentionPanel({ window, allTime, windowDays }: RetentionPanelProps) {
  const span = `last ${windowDays} days`;

  return (
    <Card
      title="True retention"
      aside={<Badge tone="neutral">{span}</Badge>}
      data-testid="stats-retention"
    >
      {window.enough ? (
        <>
          {/* The hero figure: same sans as the rest, proportional figures. */}
          <p data-testid="stats-retention-rate" className="text-5xl font-semibold">
            {formatRate(window.rate)}
          </p>
          <p data-testid="stats-retention-denominator" className="mt-1 text-sm text-muted">
            {denominator(window, span)}
          </p>
        </>
      ) : (
        <NotEnough
          testId="stats-retention-empty"
          what="reviews"
          have={window.reviews}
          needed={window.needed}
        >
          Only reviews of cards already in the Review state count, and in the {span} you have{' '}
          {formatCount(window.reviews)} of those.
        </NotEnough>
      )}

      <div className="mt-4 flex flex-wrap gap-x-8 gap-y-4 border-t border-border pt-4">
        <StatTile
          label="All time"
          testId="stats-retention-all"
          value={allTime.enough ? formatRate(allTime.rate) : '—'}
          hint={
            allTime.enough
              ? `${formatCount(allTime.recalled)} of ${formatCount(allTime.reviews)} reviews`
              : `${formatCount(allTime.reviews)} of ${formatCount(allTime.needed)} reviews needed`
          }
        />
        <StatTile
          label="Not counted"
          testId="stats-retention-excluded"
          value={formatCount(allTime.excluded)}
          hint="learning-step reviews, all time"
        />
      </div>

      <p className="mt-3 text-sm text-muted">
        Again is the only failure; Hard, Good and Easy all count as recalled. Reviews of cards
        still inside their learning steps are left out — they measure how many times you pressed a
        button in a session, not whether the interval held.
      </p>
    </Card>
  );
}
