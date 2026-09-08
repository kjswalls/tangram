/**
 * The empty states, which are the part of the dashboard most likely to lie.
 *
 * With a fresh database or the demo seed every panel here has almost no data,
 * and a chart drawn confidently over eleven points is worse than no chart. So
 * the rule these pin is: under the floor, no marks are rendered at all — a
 * sentence saying how far off the number is, instead.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CalibrationChart } from '@/components/stats/calibration-chart';
import { MaturityPanel } from '@/components/stats/maturity-panel';
import { RetentionPanel } from '@/components/stats/retention-panel';
import { WorkloadChart } from '@/components/stats/workload-chart';
import { STABILITY_BUCKETS } from '@/lib/db/repository';
import { buildParameters } from '@/lib/srs/params';
import { calibration } from '@/lib/stats/calibration';
import { trueRetention } from '@/lib/stats/retention';
import { MIN_RETENTION_REVIEWS } from '@/lib/stats/thresholds';
import { dueForecast, reviewsPerDay } from '@/lib/stats/workload';
import { NOW, dueCard, review } from './fixtures';

const W = buildParameters().w;
const ROLLOVER = 4;
const DAY = 86_400_000;

const window30 = (now: number) => ({ now, days: 30, rollover: ROLLOVER });

const emptyBuckets = STABILITY_BUCKETS.map((bucket) => ({ ...bucket, count: 0 }));

describe('the retention panel', () => {
  it('refuses to show a rate it cannot support', () => {
    const reviews = Array.from({ length: 11 }, () => review({ state: 2, rating: 3 }));
    const summary = trueRetention(reviews);
    render(<RetentionPanel window={summary} allTime={summary} windowDays={30} />);

    expect(screen.getByTestId('stats-retention-empty')).toHaveTextContent('11');
    expect(screen.getByTestId('stats-retention-empty')).toHaveTextContent(
      String(MIN_RETENTION_REVIEWS),
    );
    expect(screen.queryByTestId('stats-retention-rate')).not.toBeInTheDocument();
    // And it says how far off it is, not just that it is not ready.
    expect(screen.getByTestId('stats-retention-empty')).toHaveTextContent('19 to go');
  });

  it('shows the rate and its denominator once there are enough', () => {
    const reviews = [
      ...Array.from({ length: 45 }, () => review({ state: 2, rating: 3 })),
      ...Array.from({ length: 5 }, () => review({ state: 2, rating: 1 })),
      // Learning-state noise, which must not reach the denominator.
      ...Array.from({ length: 20 }, () => review({ state: 1, rating: 3 })),
    ];
    const summary = trueRetention(reviews);
    render(<RetentionPanel window={summary} allTime={summary} windowDays={30} />);

    expect(screen.getByTestId('stats-retention-rate')).toHaveTextContent('90%');
    expect(screen.getByTestId('stats-retention-denominator')).toHaveTextContent(
      '45 of 50 reviews recalled',
    );
    expect(screen.getByTestId('stats-retention-denominator')).toHaveTextContent(
      'already in the Review state',
    );
    expect(screen.getByTestId('stats-retention-excluded')).toHaveTextContent('20');
  });
});

describe('the calibration chart', () => {
  it('draws no dots at all below the floor', () => {
    const reviews = Array.from({ length: 40 }, () => review({ stability: 10, elapsedDays: 10 }));
    render(<CalibrationChart summary={calibration(reviews, W)} parameters="FSRS defaults" />);

    expect(screen.getByTestId('stats-calibration-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId('stats-calibration-dot')).toHaveLength(0);
    // The table is still there: the numbers are never gated behind a chart.
    expect(screen.getByTestId('stats-calibration-table')).toBeInTheDocument();
  });

  it('draws only the buckets that hold enough reviews, and says so', () => {
    const reviews = [
      ...Array.from({ length: 60 }, () => review({ stability: 10, elapsedDays: 10, rating: 3 })),
      ...Array.from({ length: 45 }, () => review({ stability: 1, elapsedDays: 1000, rating: 3 })),
      // One decile with 4 reviews: counted, reported, not drawn.
      ...Array.from({ length: 4 }, () => review({ stability: 5, elapsedDays: 60, rating: 3 })),
    ];
    const summary = calibration(reviews, W);
    render(<CalibrationChart summary={summary} parameters="FSRS defaults" />);

    const dots = screen.getAllByTestId('stats-calibration-dot');
    expect(dots).toHaveLength(2);
    expect(dots.map((dot) => dot.getAttribute('data-count'))).toEqual(['45', '60']);
    expect(screen.getByTestId('stats-calibration-note')).toHaveTextContent(
      'deciles held fewer than 10 reviews',
    );
    // The thin bucket is in the table even though it is not on the chart.
    expect(screen.getByTestId('stats-calibration-table')).toHaveTextContent('60–70%');
  });

  /**
   * The card beside this one is badged "last 30 days" and this one was badged
   * nothing, while being computed over the *whole* log (`summary.ts` passes the
   * windowed rows to retention and the unwindowed ones to calibration). An
   * unbadged neighbour reads as the same window, and after an optimizer run the
   * two panels move on different timescales for that reason alone.
   */
  it('names its own window, which is every review there is', () => {
    const reviews = [
      ...Array.from({ length: 60 }, () => review({ stability: 10, elapsedDays: 10, rating: 3 })),
      ...Array.from({ length: 45 }, () => review({ stability: 1, elapsedDays: 1000, rating: 3 })),
    ];
    render(<CalibrationChart summary={calibration(reviews, W)} parameters="FSRS defaults" />);
    expect(screen.getByTestId('stats-calibration')).toHaveTextContent('all time');
    expect(screen.getByTestId('stats-calibration-note')).toHaveTextContent(
      'reviews of cards in the Review state, all time',
    );
  });

  it('says the one sentence that communicates, with or without a curve', () => {
    // One decile: no curve to draw, and the overall bias still leads the card.
    const oneDecile = Array.from({ length: 205 }, () => review({ stability: 100, elapsedDays: 1 }));
    render(<CalibrationChart summary={calibration(oneDecile, W)} parameters="FSRS defaults" />);
    expect(screen.getByTestId('stats-calibration-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId('stats-calibration-dot')).toHaveLength(0);
    expect(screen.getByTestId('stats-calibration-bias')).toBeInTheDocument();
  });
});

describe('the workload chart', () => {
  it('says there is nothing rather than drawing an empty axis', () => {
    render(
      <WorkloadChart
        past={reviewsPerDay([], window30(NOW))}
        forecast={dueForecast([], window30(NOW))}
        peak={0}
        windowDays={30}
      />,
    );
    expect(screen.getByTestId('stats-workload-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId('stats-workload-bar')).toHaveLength(0);
    // 59 days either side of today, as numbers, even with nothing in them.
    expect(screen.getAllByTestId('stats-workload-row')).toHaveLength(59);
  });

  it('draws both series, and never counts a day twice', () => {
    const past = reviewsPerDay(
      [review({ reviewedAt: NOW }), review({ reviewedAt: NOW - 2 * DAY })],
      window30(NOW),
    );
    const forecast = dueForecast([dueCard(NOW + 3 * DAY), dueCard(NOW - DAY)], window30(NOW));
    render(<WorkloadChart past={past} forecast={forecast} peak={2} windowDays={30} />);

    const bars = screen.getAllByTestId('stats-workload-bar');
    expect(bars).toHaveLength(4);
    expect(bars.filter((bar) => bar.getAttribute('data-series') === 'past')).toHaveLength(2);
    expect(screen.getByTestId('stats-workload-note')).toHaveTextContent('already overdue');
  });

  /**
   * The legend is the only thing that says which colour is which series, and
   * its swatches were painted with `var(--viz-s1)` — a custom property declared
   * on `.viz` alone, which `ChartFrame` carries and the legend, mounted one line
   * above it, did not. Measured in a browser the swatches were
   * `10px x 10px bg=rgba(0, 0, 0, 0)`: two grey labels and no marks.
   */
  it('gives its legend the token scope its swatches are painted in', () => {
    const past = reviewsPerDay([review({ reviewedAt: NOW })], window30(NOW));
    const forecast = dueForecast([dueCard(NOW + 3 * DAY)], window30(NOW));
    const { container } = render(
      <WorkloadChart past={past} forecast={forecast} peak={2} windowDays={30} />,
    );
    const legend = container.querySelector('ul');
    expect(legend).not.toBeNull();
    expect(legend!.classList.contains('viz')).toBe(true);
    const swatch = legend!.querySelector('span[aria-hidden]') as HTMLElement;
    expect(swatch.style.background).toContain('--viz-s1');
  });
});

describe('the maturity panel', () => {
  it('has nothing to say about a database with no cards', () => {
    render(
      <MaturityPanel
        states={{ new: 0, learning: 0, review: 0, relearning: 0, total: 0 }}
        stability={emptyBuckets}
        known={0}
      />,
    );
    expect(screen.getByTestId('stats-maturity-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId('stats-stability-bar')).toHaveLength(0);
  });

  it('counts states exactly, because a count needs no floor', () => {
    render(
      <MaturityPanel
        states={{ new: 7, learning: 2, review: 3, relearning: 1, total: 13 }}
        stability={emptyBuckets.map((bucket, index) => ({ ...bucket, count: index === 3 ? 3 : 0 }))}
        known={3}
      />,
    );
    expect(screen.getByTestId('stats-state-new')).toHaveTextContent('7');
    expect(screen.getByTestId('stats-state-relearning')).toHaveTextContent('1');
    expect(screen.getByTestId('stats-known')).toHaveTextContent('3');
    expect(screen.getAllByTestId('stats-stability-bar')).toHaveLength(1);
  });

  it('says the histogram is empty when every card is still New', () => {
    render(
      <MaturityPanel
        states={{ new: 6, learning: 0, review: 0, relearning: 0, total: 6 }}
        stability={emptyBuckets}
        known={0}
      />,
    );
    expect(screen.getByTestId('stats-stability-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId('stats-stability-bar')).toHaveLength(0);
  });
});
