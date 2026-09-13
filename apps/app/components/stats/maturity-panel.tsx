'use client';

/**
 * Maturity: how many cards there are, what state they are in, and how much of
 * the collection has actually consolidated (Phase 8).
 *
 * The four state counts are a handful of headline numbers, so they are stat
 * tiles rather than a four-colour bar chart — a legend that says "Relearning is
 * the orange one" is work the reader should not have to do for four numbers.
 *
 * The histogram is ordered buckets of one quantity, so it takes a one-hue
 * ordinal ramp (light→dark, flipped for the dark surface) rather than
 * categorical hues: the colour carries the order, which is the thing that
 * matters here. The 21-day edge is the same threshold the reader paints a word
 * "known" at, so growth in the right-hand bars is growth in the text you can
 * read.
 */

import { RAMP_VARS } from '@/components/stats/chart-tokens';
import {
  ChartFrame,
  ChartTooltip,
  EmptyNote,
  StatTile,
  TableView,
  formatCount,
  useTooltip,
} from '@/components/stats/primitives';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { CardStateCounts, StabilityBucket } from '@/lib/db/repository';
import { KNOWN_STABILITY_DAYS } from '@/lib/srs/states';
import { STATE_TILES, histogramTotal } from '@/lib/stats/maturity';

const W = 360;
const ROW = 26;
const BAR = 14;
const LABEL_W = 58;
const X0 = 66;
const X1 = 300;

/** A bar with a rounded data-end and a square foot at the baseline. */
function barPath(x: number, y: number, width: number, height: number): string {
  if (width <= 0) return '';
  const r = Math.min(4, width, height / 2);
  return [
    `M ${x} ${y}`,
    `L ${x + width - r} ${y}`,
    `Q ${x + width} ${y} ${x + width} ${y + r}`,
    `L ${x + width} ${y + height - r}`,
    `Q ${x + width} ${y + height} ${x + width - r} ${y + height}`,
    `L ${x} ${y + height}`,
    'Z',
  ].join(' ');
}

export interface MaturityPanelProps {
  states: CardStateCounts;
  stability: StabilityBucket[];
  known: number;
}

export function MaturityPanel({ states, stability, known }: MaturityPanelProps) {
  const { tooltip, setTooltip } = useTooltip();
  const total = histogramTotal(stability);
  const max = stability.reduce((top, bucket) => Math.max(top, bucket.count), 0);
  const height = stability.length * ROW + 8;

  return (
    <Card
      title="Maturity"
      aside={
        states.total > 0 ? (
          <Badge tone="neutral" data-testid="stats-card-total">
            {formatCount(states.total)} cards
          </Badge>
        ) : null
      }
      data-testid="stats-maturity"
    >
      {states.total === 0 ? (
        <EmptyNote testId="stats-maturity-empty">
          No cards yet. Look a word up, or open Today to draw the day&rsquo;s new words.
        </EmptyNote>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            {STATE_TILES.map((tile) => (
              <StatTile
                key={tile.key}
                label={tile.label}
                hint={tile.hint}
                testId={`stats-state-${tile.key}`}
                value={formatCount(states[tile.key])}
              />
            ))}
          </div>

          <div className="mt-5 border-t border-border pt-4">
            <p className="text-sm">
              <span data-testid="stats-known" className="font-semibold">
                {formatCount(known)}
              </span>{' '}
              <span className="text-muted">
                of {formatCount(total)} scheduled cards have passed {KNOWN_STABILITY_DAYS} days of
                stability — the same threshold the reader paints a word &ldquo;known&rdquo; at.
              </span>
            </p>

            {total === 0 ? (
              <EmptyNote testId="stats-stability-empty">
                Every card is still New, so there is no stability to plot yet.
              </EmptyNote>
            ) : (
              <ChartFrame className="mt-3 max-w-[560px]">
                <svg
                  viewBox={`0 0 ${W} ${height}`}
                  role="img"
                  aria-label="Cards by memory stability"
                  onPointerLeave={() => setTooltip(null)}
                >
                  <line x1={X0} x2={X0} y1={4} y2={height - 4} stroke="var(--viz-axis)" strokeWidth={1} />
                  {stability.map((bucket, index) => {
                    const y = index * ROW + 4;
                    const width = max > 0 ? (bucket.count / max) * (X1 - X0) : 0;
                    const barTop = y + (ROW - BAR) / 2;
                    const readout = () =>
                      setTooltip({
                        x: X0 + width,
                        y: barTop + BAR / 2,
                        title: `${bucket.label} stability`,
                        lines: [
                          {
                            label: bucket.count === 1 ? 'card' : 'cards',
                            value: formatCount(bucket.count),
                            color: RAMP_VARS[index] ?? RAMP_VARS[RAMP_VARS.length - 1],
                          },
                        ],
                      });
                    return (
                      <g key={bucket.label}>
                        <text
                          x={LABEL_W}
                          y={barTop + BAR - 3}
                          textAnchor="end"
                          fontSize={10}
                          fill="var(--viz-muted)"
                          style={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                          {bucket.label}
                        </text>
                        {width > 0 ? (
                          <path
                            d={barPath(X0, barTop, width, BAR)}
                            fill={RAMP_VARS[index] ?? RAMP_VARS[RAMP_VARS.length - 1]}
                            data-testid="stats-stability-bar"
                            data-bucket={bucket.label}
                            data-count={bucket.count}
                          />
                        ) : null}
                        <text
                          x={X0 + width + 6}
                          y={barTop + BAR - 3}
                          fontSize={10}
                          fill="var(--viz-ink)"
                          style={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                          {formatCount(bucket.count)}
                        </text>
                        {/* The row is the hit target, not the 14px bar. */}
                        <rect
                          x={X0}
                          y={y}
                          width={X1 - X0}
                          height={ROW}
                          fill="transparent"
                          tabIndex={0}
                          role="img"
                          aria-label={`${bucket.label}: ${formatCount(bucket.count)} cards`}
                          onPointerEnter={readout}
                          onFocus={readout}
                          onBlur={() => setTooltip(null)}
                        />
                      </g>
                    );
                  })}
                </svg>
                <ChartTooltip tooltip={tooltip} width={W} height={height} />
              </ChartFrame>
            )}
          </div>
        </>
      )}

      <TableView
        label="Stability, as numbers"
        testId="stats-stability-table"
        head={['Stability', 'Cards']}
        rows={stability.map((bucket) => ({
          key: bucket.label,
          data: { 'data-bucket': bucket.label },
          cells: [bucket.label, formatCount(bucket.count)],
        }))}
      />
    </Card>
  );
}
