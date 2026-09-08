'use client';

/**
 * Predicted against actual — the chart that says whether the parameters are
 * any good (Phase 8).
 *
 * Each dot is a decile of FSRS's own predicted recall probability: x is what it
 * predicted on average for the reviews in that decile, y is the share that were
 * actually recalled. On the diagonal is calibrated. Above it the scheduler is
 * pessimistic (intervals could be longer); below it, optimistic — you are
 * forgetting more often than it thinks, which is the case that costs you.
 *
 * Two things keep it honest, both of them from the brief:
 *
 * - **The count is on the chart.** Dot area carries it at a glance, the number
 *   sits beside the dot, and the table view lists every bucket including the
 *   ones that were not drawn. There are at most ten labels and usually three,
 *   so labelling each is legible rather than the flood the rule warns about.
 * - **A bucket under ten reviews is not drawn at all.** With three reviews the
 *   only observable rates are 0, 33, 67 and 100 percent, so a dot would be
 *   plotting sampling noise as if it were evidence. The reviews are reported
 *   under the chart instead of vanishing.
 */

import { ChartFrame, ChartTooltip, TableView, formatCount, useTooltip } from '@/components/stats/primitives';
import { SERIES_1 } from '@/components/stats/chart-tokens';
import { Card } from '@/components/ui/card';
import { NotEnough } from '@/components/stats/primitives';
import type { CalibrationBucket, CalibrationSummary } from '@/lib/stats/calibration';
import { formatRate } from '@/lib/stats/retention';

const W = 264;
const H = 258;
const X0 = 44;
const X1 = 252;
const Y0 = 12;
const Y1 = 220;

const sx = (value: number) => X0 + value * (X1 - X0);
const sy = (value: number) => Y1 - value * (Y1 - Y0);

const TICKS = [0, 0.25, 0.5, 0.75, 1];
/** Closer than this and two count labels would sit on top of each other. */
const LABEL_MIN_GAP = 26;
const LABELLED = new Set([0, 0.5, 1]);

function radius(count: number, max: number): number {
  if (max <= 0) return 4;
  // Area, not radius, carries the count — a radius-linear dot overstates the
  // big buckets by the square of everything.
  return 4 + 5 * Math.sqrt(count / max);
}

function bucketLabel(bucket: CalibrationBucket): string {
  return `${Math.round(bucket.lower * 100)}–${Math.round(bucket.upper * 100)}%`;
}

/**
 * Where each count label goes.
 *
 * Deciles crowd at the top of the scale — a well-fitted scheduler predicts 85%
 * and up almost every time — so consecutive labels alternate above and below
 * their dot, which is what keeps them apart. A label with nowhere left to go
 * (a dot against the ceiling whose neighbour is already below it) is dropped
 * rather than drawn over its neighbour: the count is still in the tooltip and
 * in the table, and a legible chart with nine labels beats an illegible one
 * with ten.
 */
function placeLabels(
  drawn: readonly CalibrationBucket[],
  max: number,
): { above: boolean; labelled: boolean }[] {
  let lastAbove = Number.NEGATIVE_INFINITY;
  let lastBelow = Number.NEGATIVE_INFINITY;
  return drawn.map((bucket, position) => {
    const cx = sx(bucket.predictedMean);
    const cy = sy(bucket.observed);
    const fitsAbove = cy - radius(bucket.count, max) - 6 > Y0 + 10;
    const above = position % 2 === 0 && fitsAbove;
    const previous = above ? lastAbove : lastBelow;
    const labelled = cx - previous >= LABEL_MIN_GAP;
    if (labelled) {
      if (above) lastAbove = cx;
      else lastBelow = cx;
    }
    return { above, labelled };
  });
}

export function CalibrationChart({
  summary,
  parameters,
}: {
  summary: CalibrationSummary;
  parameters: string;
}) {
  const { tooltip, setTooltip } = useTooltip();
  const drawn = summary.drawn;
  const max = drawn.reduce((top, bucket) => Math.max(top, bucket.count), 0);
  const labels = placeLabels(drawn, max);

  const rows = summary.buckets.map((bucket) => ({
    key: String(bucket.index),
    data: { 'data-bucket': String(bucket.index) },
    cells: [
      bucketLabel(bucket),
      formatCount(bucket.count),
      bucket.count > 0 ? formatRate(bucket.predictedMean) : '—',
      bucket.enough ? formatRate(bucket.observed) : '—',
    ],
  }));

  return (
    <Card title="Calibration" data-testid="stats-calibration">
      {summary.enough ? (
        <>
          {/* Capped: the SVG scales with its box, so a full-width card would
              scale 9px axis type up to 20px and the chart would read as a
              poster. Left-aligned rather than centred — it is a dashboard. */}
          <ChartFrame className="max-w-[400px]">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              role="img"
              aria-label={`Predicted against observed recall, ${drawn.length} deciles with at least ${summary.minBucketReviews} reviews each.`}
              onPointerLeave={() => setTooltip(null)}
            >
              {TICKS.map((tick) => (
                <g key={tick}>
                  <line
                    x1={X0}
                    x2={X1}
                    y1={sy(tick)}
                    y2={sy(tick)}
                    stroke="var(--viz-grid)"
                    strokeWidth={1}
                  />
                  <line
                    x1={sx(tick)}
                    x2={sx(tick)}
                    y1={Y0}
                    y2={Y1}
                    stroke="var(--viz-grid)"
                    strokeWidth={1}
                  />
                </g>
              ))}

              {/* The reference the whole chart is read against. Solid, one step
                  stronger than the grid, and named — an unlabelled diagonal
                  gets read as a series. */}
              <line
                x1={sx(0)}
                y1={sy(0)}
                x2={sx(1)}
                y2={sy(1)}
                stroke="var(--viz-axis)"
                strokeWidth={1}
              />
              {/* Named on the line itself, low down where the dots are not:
                  predictions cluster at the top right, so a label in that
                  corner lands on the data it is meant to explain. */}
              <text
                x={sx(0.26) + 5}
                y={sy(0.26) + 12}
                textAnchor="start"
                fontSize={9}
                fill="var(--viz-muted)"
              >
                perfectly calibrated
              </text>

              <line x1={X0} x2={X1} y1={Y1} y2={Y1} stroke="var(--viz-axis)" strokeWidth={1} />
              <line x1={X0} x2={X0} y1={Y0} y2={Y1} stroke="var(--viz-axis)" strokeWidth={1} />

              {TICKS.filter((tick) => LABELLED.has(tick)).map((tick) => (
                <g key={`label-${tick}`}>
                  <text
                    x={X0 - 6}
                    y={sy(tick) + 3}
                    textAnchor="end"
                    fontSize={9}
                    fill="var(--viz-muted)"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {Math.round(tick * 100)}%
                  </text>
                  <text
                    x={sx(tick)}
                    y={Y1 + 14}
                    textAnchor="middle"
                    fontSize={9}
                    fill="var(--viz-muted)"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {Math.round(tick * 100)}%
                  </text>
                </g>
              ))}

              <text x={(X0 + X1) / 2} y={H - 12} textAnchor="middle" fontSize={10} fill="var(--viz-muted)">
                predicted recall
              </text>
              <text
                transform={`rotate(-90 12 ${(Y0 + Y1) / 2})`}
                x={12}
                y={(Y0 + Y1) / 2}
                textAnchor="middle"
                fontSize={10}
                fill="var(--viz-muted)"
              >
                observed recall
              </text>

              {drawn.length > 1 ? (
                <polyline
                  points={drawn.map((bucket) => `${sx(bucket.predictedMean)},${sy(bucket.observed)}`).join(' ')}
                  fill="none"
                  stroke={SERIES_1}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : null}

              {drawn.map((bucket, position) => {
                const cx = sx(bucket.predictedMean);
                const cy = sy(bucket.observed);
                const r = radius(bucket.count, max);
                // Deciles crowd together at the top of the scale, so the counts
                // alternate above and below the dots they belong to; a label
                // that still would not clear its neighbour is dropped rather
                // than drawn over it, and stays in the tooltip and the table.
                const { above, labelled } = labels[position];
                return (
                  <g key={bucket.index}>
                    <circle
                      cx={cx}
                      cy={cy}
                      r={r}
                      fill={SERIES_1}
                      stroke="var(--viz-surface)"
                      strokeWidth={2}
                      data-testid="stats-calibration-dot"
                      data-bucket={bucket.index}
                      data-count={bucket.count}
                    />
                    {/* A label centred on the top decile's dot would run off the
                        plot and land on the diagonal's end; near the edge it
                        hangs to the left of the mark instead. */}
                    {labelled ? (
                      <text
                        x={cx > X1 - 14 ? cx - r - 3 : cx}
                        y={above ? cy - r - 6 : cy + r + 11}
                        textAnchor={cx > X1 - 14 ? 'end' : 'middle'}
                        fontSize={9}
                        fill="var(--viz-muted)"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        {formatCount(bucket.count)}
                      </text>
                    ) : null}
                    {/* The hit area is the mark plus room: a 9px dot is a
                        pinpoint nobody lands on. */}
                    <circle
                      cx={cx}
                      cy={cy}
                      r={Math.max(14, r + 8)}
                      fill="transparent"
                      tabIndex={0}
                      role="img"
                      aria-label={`Predicted ${bucketLabel(bucket)}: ${formatRate(bucket.observed)} observed over ${formatCount(bucket.count)} reviews`}
                      onPointerEnter={() =>
                        setTooltip({
                          x: cx,
                          y: cy,
                          title: `predicted ${bucketLabel(bucket)}`,
                          lines: [
                            { label: 'observed', value: formatRate(bucket.observed), color: SERIES_1 },
                            { label: 'reviews', value: formatCount(bucket.count) },
                          ],
                        })
                      }
                      onFocus={() =>
                        setTooltip({
                          x: cx,
                          y: cy,
                          title: `predicted ${bucketLabel(bucket)}`,
                          lines: [
                            { label: 'observed', value: formatRate(bucket.observed), color: SERIES_1 },
                            { label: 'reviews', value: formatCount(bucket.count) },
                          ],
                        })
                      }
                      onBlur={() => setTooltip(null)}
                    />
                  </g>
                );
              })}
            </svg>
            <ChartTooltip tooltip={tooltip} width={W} height={H} />
          </ChartFrame>

          <p data-testid="stats-calibration-note" className="mt-2 text-sm text-muted">
            {formatCount(summary.used)} reviews of cards in the Review state, in {drawn.length} of 10
            deciles. Dot size is the reviews behind it.
            {summary.thin > 0 ? (
              <>
                {' '}
                {10 - drawn.length} deciles held fewer than {summary.minBucketReviews} reviews (
                {formatCount(summary.thin)} in all) and are not drawn.
              </>
            ) : null}
          </p>
          {summary.bias !== null ? (
            <p data-testid="stats-calibration-bias" className="mt-1 text-sm text-muted">
              Overall it predicted {formatRate(summary.predictedMean)} and you recalled{' '}
              {formatRate(summary.observedMean)} —{' '}
              {Math.abs(summary.bias) < 0.02
                ? 'as close as this many reviews can show.'
                : summary.bias > 0
                  ? 'the schedule is more cautious than it needs to be.'
                  : 'the schedule is more optimistic than your answers.'}
            </p>
          ) : null}
        </>
      ) : (
        <NotEnough
          testId="stats-calibration-empty"
          what="reviews"
          have={summary.used}
          needed={summary.needed}
        >
          A calibration curve is ten rates, not one, so it needs the reviews to spread out before
          any decile holds enough to plot.
        </NotEnough>
      )}

      <TableView
        label="Every decile, including the ones not drawn"
        testId="stats-calibration-table"
        head={['Predicted', 'Reviews', 'Mean predicted', 'Observed']}
        rows={rows}
      />

      <p className="mt-3 text-sm text-muted">
        Predictions are recomputed from your review log with the parameters in force now
        {parameters ? ` (${parameters.toLowerCase()})` : null}, so changing them changes this chart.
      </p>
    </Card>
  );
}
