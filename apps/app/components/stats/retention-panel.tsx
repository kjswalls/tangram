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
  return `${formatCount(summary.recalled)} of ${formatCount(summary.reviews)} remembered — words you were coming back to after getting them right before, ${span}`;
}

export function RetentionPanel({ window, allTime, windowDays }: RetentionPanelProps) {
  const span = `last ${windowDays} days`;

  return (
    <Card
      // C8: plain English. "True retention" is the SRS community's term for
      // this number and it means nothing to a learner; what they want to know
      // is whether the words are staying put.
      title="How well it’s sticking"
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
          Only words you were coming back to after a day or more count, and in the {span} you
          have {formatCount(window.reviews)} of those.
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
          // Not "same-sitting tries": the excluded set is every review of a
          // word that was not yet in the come-back-later state — which is each
          // word's **first** meeting as well as the repeats, and any word being
          // relearned. Found by C8's adversarial review.
          hint="first meetings and words you were relearning, all time"
        />
      </div>

      {/* C8's rule, applied to the one paragraph on this panel: the old copy
          named the four buttons by their old names, so it was both jargon and
          out of date the moment `RATING_LABELS` changed. */}
      <p className="mt-3 text-sm text-muted">
        “Forgot it” is the only miss; the other three all count as remembered. Words you had not
        got right yet are left out — the first time you meet a word, and any you were relearning —
        because those say how many times you pressed a button, not whether the word stayed with
        you.
      </p>
    </Card>
  );
}
