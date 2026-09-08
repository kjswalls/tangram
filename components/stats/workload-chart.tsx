'use client';

/**
 * Workload: the last 30 days of reviews and the next 30 days of cards coming
 * due, on one axis, split at today (Phase 8).
 *
 * They share an axis because they are the same unit — reviews in a day — and
 * because a forecast alone tells you nothing. "180 due on Thursday" is only
 * frightening next to the 40-a-day you actually do, and seeing it on Monday is
 * the entire point of the panel.
 *
 * Today appears on both sides of the divider, and deliberately: to its left is
 * what you have already done today, to its right what is still due today
 * (including anything overdue). A card reviewed today has been rescheduled and
 * is no longer due today, so nothing is counted twice.
 */

import { useRef, useState } from 'react';

import { SERIES_1, SERIES_2 } from '@/components/stats/chart-tokens';
import {
  ChartFrame,
  ChartTooltip,
  EmptyNote,
  Legend,
  TableView,
  formatCount,
  useTooltip,
} from '@/components/stats/primitives';
import { Card } from '@/components/ui/card';
import type { DayCount, Forecast } from '@/lib/stats/workload';

const W = 360;
const H = 196;
const X0 = 30;
const X1 = 352;
const Y0 = 16;
const Y1 = 150;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `12 Aug`, in the browser's own timezone, with no locale in the loop. */
export function formatDay(start: number): string {
  const date = new Date(start);
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** A y-axis top that is a round number, so the tick is readable. */
export function niceTop(peak: number): number {
  if (peak <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= peak) return candidate;
  }
  return 10 * magnitude;
}

/**
 * A column with a rounded cap and a square foot. A plain `rx` rounds all four
 * corners, which lifts the bar off its own baseline.
 */
function columnPath(x: number, y: number, width: number, height: number): string {
  if (height <= 0) return '';
  const r = Math.min(2, width / 2, height);
  return [
    `M ${x} ${y + height}`,
    `L ${x} ${y + r}`,
    `Q ${x} ${y} ${x + r} ${y}`,
    `L ${x + width - r} ${y}`,
    `Q ${x + width} ${y} ${x + width} ${y + r}`,
    `L ${x + width} ${y + height}`,
    'Z',
  ].join(' ');
}

export interface WorkloadChartProps {
  past: DayCount[];
  forecast: Forecast;
  peak: number;
  windowDays: number;
}

export function WorkloadChart({ past, forecast, peak, windowDays }: WorkloadChartProps) {
  const { tooltip, setTooltip } = useTooltip();
  const [cursor, setCursor] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const future = forecast.days;
  const columns = [
    ...past.map((day) => ({ day, series: 'past' as const })),
    ...future.map((day) => ({ day, series: 'future' as const })),
  ];
  const slot = (X1 - X0) / columns.length;
  const barWidth = Math.max(1.5, slot - 2);
  const top = niceTop(peak);
  const scale = (count: number) => (count / top) * (Y1 - Y0);
  const divider = X0 + past.length * slot;

  const reviewed = past.reduce((total, day) => total + day.count, 0);
  const empty = reviewed === 0 && forecast.scheduled === 0;

  const show = (index: number) => {
    const column = columns[index];
    if (!column) return;
    const x = X0 + index * slot + slot / 2;
    setCursor(index);
    setTooltip({
      x,
      y: Y1 - scale(column.day.count) - 8,
      title: formatDay(column.day.start),
      lines: [
        column.series === 'past'
          ? { label: 'reviewed', value: formatCount(column.day.count), color: SERIES_1 }
          : { label: 'coming due', value: formatCount(column.day.count), color: SERIES_2 },
      ],
    });
  };

  const clear = () => {
    setCursor(null);
    setTooltip(null);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const x = ((event.clientX - box.left) / box.width) * W;
    const index = Math.floor((x - X0) / slot);
    if (index < 0 || index >= columns.length) {
      clear();
      return;
    }
    show(index);
  };

  const onKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const from = cursor ?? past.length;
    const next = Math.min(columns.length - 1, Math.max(0, from + (event.key === 'ArrowRight' ? 1 : -1)));
    show(next);
  };

  // One direct label per series — the tallest column. Every other value is in
  // the tooltip and in the table.
  const peakPast = past.reduce((best, day, index) => (day.count > past[best].count ? index : best), 0);
  const peakFuture = future.reduce((best, day, index) => (day.count > future[best].count ? index : best), 0);

  const merged = new Map<string, { start: number; reviewed: number; due: number }>();
  for (const day of past) {
    merged.set(day.dayKey, { start: day.start, reviewed: day.count, due: 0 });
  }
  for (const day of future) {
    const row = merged.get(day.dayKey);
    if (row) row.due = day.count;
    else merged.set(day.dayKey, { start: day.start, reviewed: 0, due: day.count });
  }
  const rows = [...merged.entries()]
    .sort((a, b) => a[1].start - b[1].start)
    .map(([dayKey, row]) => ({
      key: dayKey,
      testId: 'stats-workload-row',
      data: {
        'data-day': dayKey,
        'data-reviewed': String(row.reviewed),
        'data-due': String(row.due),
      },
      cells: [formatDay(row.start), formatCount(row.reviewed), formatCount(row.due)],
    }));

  return (
    <Card title="Workload" data-testid="stats-workload">
      {empty ? (
        <EmptyNote testId="stats-workload-empty">
          No reviews in the last {windowDays} days, and nothing scheduled for the next {windowDays}.
          The chart appears with the first card you grade.
        </EmptyNote>
      ) : (
        <>
          <Legend
            items={[
              { label: `Reviewed (last ${windowDays} days)`, color: SERIES_1 },
              { label: `Coming due (next ${windowDays})`, color: SERIES_2 },
            ]}
          />
          {/* Capped for the same reason as the calibration chart: the type
              inside an SVG scales with the box it is given. */}
          <ChartFrame className="mt-2 max-w-[560px]">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              role="img"
              tabIndex={0}
              className="viz-plot"
              aria-label={`Reviews per day for the last ${windowDays} days and cards coming due for the next ${windowDays}. Use the arrow keys to read each day.`}
              onPointerMove={onPointerMove}
              onPointerLeave={clear}
              onKeyDown={onKeyDown}
              onBlur={clear}
            >
              {[0, 0.5, 1].map((fraction) => (
                <g key={fraction}>
                  <line
                    x1={X0}
                    x2={X1}
                    y1={Y1 - fraction * (Y1 - Y0)}
                    y2={Y1 - fraction * (Y1 - Y0)}
                    stroke={fraction === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'}
                    strokeWidth={1}
                  />
                  <text
                    x={X0 - 6}
                    y={Y1 - fraction * (Y1 - Y0) + 3}
                    textAnchor="end"
                    fontSize={9}
                    fill="var(--viz-muted)"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {formatCount(Math.round(fraction * top))}
                  </text>
                </g>
              ))}

              {columns.map((column, index) => {
                const height = scale(column.day.count);
                const x = X0 + index * slot + (slot - barWidth) / 2;
                if (height <= 0) return null;
                return (
                  <path
                    key={`${column.series}-${column.day.dayKey}`}
                    d={columnPath(x, Y1 - height, barWidth, height)}
                    fill={column.series === 'past' ? SERIES_1 : SERIES_2}
                    data-testid="stats-workload-bar"
                    data-series={column.series}
                    data-day={column.day.dayKey}
                    data-count={column.day.count}
                  />
                );
              })}

              {/* Today, twice: done on the left of the line, still due on the
                  right. The label sits on the axis row with the two dates
                  rather than over the plot, where the tallest column's own
                  value label lives. */}
              <line x1={divider} x2={divider} y1={Y0 - 2} y2={Y1} stroke="var(--viz-axis)" strokeWidth={1} />
              <text x={divider} y={Y1 + 14} textAnchor="middle" fontSize={9} fill="var(--viz-muted)">
                today
              </text>

              {cursor !== null ? (
                <line
                  x1={X0 + cursor * slot + slot / 2}
                  x2={X0 + cursor * slot + slot / 2}
                  y1={Y0}
                  y2={Y1}
                  stroke="var(--viz-axis)"
                  strokeWidth={1}
                  pointerEvents="none"
                />
              ) : null}

              {past[peakPast] && past[peakPast].count > 0 ? (
                <text
                  x={X0 + peakPast * slot + slot / 2}
                  y={Y1 - scale(past[peakPast].count) - 5}
                  textAnchor="middle"
                  fontSize={9}
                  fill="var(--viz-ink)"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {formatCount(past[peakPast].count)}
                </text>
              ) : null}
              {future[peakFuture] && future[peakFuture].count > 0 ? (
                <text
                  x={X0 + (past.length + peakFuture) * slot + slot / 2}
                  y={Y1 - scale(future[peakFuture].count) - 5}
                  textAnchor="middle"
                  fontSize={9}
                  fill="var(--viz-ink)"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {formatCount(future[peakFuture].count)}
                </text>
              ) : null}

              {past[0] ? (
                <text x={X0} y={Y1 + 14} textAnchor="start" fontSize={9} fill="var(--viz-muted)">
                  {formatDay(past[0].start)}
                </text>
              ) : null}
              {future[future.length - 1] ? (
                <text x={X1} y={Y1 + 14} textAnchor="end" fontSize={9} fill="var(--viz-muted)">
                  {formatDay(future[future.length - 1].start)}
                </text>
              ) : null}
            </svg>
            <ChartTooltip tooltip={tooltip} width={W} height={H} />
          </ChartFrame>

          <p data-testid="stats-workload-note" className="mt-2 text-sm text-muted">
            {formatCount(reviewed)} reviews in the last {windowDays} days.{' '}
            {formatCount(forecast.counted)} cards land in the next {windowDays}
            {forecast.overdue > 0 ? (
              <>
                , of which {formatCount(forecast.overdue)} {forecast.overdue === 1 ? 'is' : 'are'}{' '}
                already overdue and sit on today
              </>
            ) : null}
            {forecast.beyond > 0 ? <>; {formatCount(forecast.beyond)} more are scheduled beyond it</> : null}.
            New cards are not counted — a new card is introduced by the daily cap, not by a due date.
          </p>
        </>
      )}

      <TableView
        label="Every day, as numbers"
        testId="stats-workload-table"
        head={['Day', 'Reviewed', 'Coming due']}
        rows={rows}
      />
    </Card>
  );
}
