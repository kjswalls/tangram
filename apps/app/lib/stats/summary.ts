/**
 * The dashboard's one read of the world (Phase 8, `/stats`).
 *
 * Everything the page draws is derived here, from repository queries only — the
 * view never opens Dexie and never re-derives a number a chart already has. Two
 * consequences worth keeping:
 *
 * - **One window definition.** "The last 30 days" is computed once
 *   (`studyDaysEndingAt`) and used by both the retention figure and the reviews
 *   bar chart, so the two panels are talking about the same 30 days. (They are
 *   not the same *count*: the bars are every review, the retention figure only
 *   the ones of cards already in the Review state — which is why the panel
 *   states its denominator.) Two windows spelled twice is how a dashboard
 *   starts contradicting itself.
 * - **One read of the review log.** `allReviewsChronological()` is the source
 *   for all-time retention, the 30-day slice and calibration; slicing in memory
 *   is cheaper than three index scans and, more importantly, means the three
 *   panels are looking at the same rows.
 */

import type { CardStateCounts, Repository, StabilityBucket } from '@/lib/db/repository';
import type { ReviewRow, SettingsRow } from '@/lib/db/schema';
import { buildParameters, describeParameters } from '@/lib/srs/params';
import { calibration, type CalibrationSummary } from '@/lib/stats/calibration';
import { knownCount } from '@/lib/stats/maturity';
import { trueRetention, type RetentionSummary } from '@/lib/stats/retention';
import { WINDOW_DAYS } from '@/lib/stats/thresholds';
import {
  dueForecast,
  peak,
  reviewsPerDay,
  studyDaysEndingAt,
  type DayCount,
  type Forecast,
} from '@/lib/stats/workload';

export interface StatsSummary {
  now: number;
  settings: SettingsRow;
  /** How many days each half of the workload chart spans. */
  windowDays: number;
  /** The instant the 30-day window opens — the retention figure's cut. */
  windowStart: number;
  /** `describeParameters()`: which weights these predictions were made with. */
  parameters: string;
  retentionWindow: RetentionSummary;
  retentionAllTime: RetentionSummary;
  calibration: CalibrationSummary;
  reviewsPerDay: DayCount[];
  forecast: Forecast;
  /** The shared y-scale for the workload chart's two series. */
  workloadPeak: number;
  states: CardStateCounts;
  stability: StabilityBucket[];
  known: number;
  /** Every review row in the database, counted — the "is there anything" test. */
  totalReviews: number;
}

export interface StatsInput {
  repo: Repository;
  now?: number;
  /** Overridable so a test does not have to own 30 days of fixtures. */
  windowDays?: number;
}

export async function loadStats({
  repo,
  now = Date.now(),
  windowDays = WINDOW_DAYS,
}: StatsInput): Promise<StatsSummary> {
  const [settings, reviews, cards, states, stability] = await Promise.all([
    repo.getSettings(),
    repo.allReviewsChronological(),
    repo.allCards(),
    repo.cardCountsByState(),
    repo.stabilityHistogram(),
  ]);

  const rollover = settings.dayRollover;
  const columns = studyDaysEndingAt(now, windowDays, rollover);
  const windowStart = columns[0]?.start ?? now;
  const windowed: ReviewRow[] = reviews.filter((review) => review.reviewedAt >= windowStart);

  const perDay = reviewsPerDay(windowed, { now, days: windowDays, rollover });
  const forecast = dueForecast(cards, { now, days: windowDays, rollover });

  return {
    now,
    settings,
    windowDays,
    windowStart,
    parameters: describeParameters(settings),
    retentionWindow: trueRetention(windowed),
    retentionAllTime: trueRetention(reviews),
    // The weights in force right now, not the ones each review was scheduled
    // under: the question this chart answers is how today's parameters score
    // the history (see `calibration.ts`).
    calibration: calibration(reviews, buildParameters(settings).w),
    reviewsPerDay: perDay,
    forecast,
    workloadPeak: peak(perDay, forecast.days),
    states,
    stability,
    known: knownCount(stability),
    totalReviews: reviews.length,
  };
}
