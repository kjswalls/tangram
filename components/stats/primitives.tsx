'use client';

/**
 * The pieces every panel on `/stats` is built from (Phase 8).
 *
 * Two of them carry rules rather than styling:
 *
 * - `NotEnough` is the honest empty state. It never draws an axis or a zeroed
 *   chart — a chart that lies when it is empty is worse than no chart — and it
 *   always says *how far off* the number is, because "come back later" with no
 *   distance is indistinguishable from "this is broken".
 * - `TableView` is the accessible twin every chart on this page carries. Hover
 *   is an enhancement; the table is the guarantee that no value on the page is
 *   reachable only by pointing at it.
 */

import { useId, useState, type ReactNode } from 'react';

import { cn } from '@/lib/cn';

/** `1,240` — grouped the same way on every machine, no locale in the loop. */
export function formatCount(value: number): string {
  const whole = Math.trunc(value);
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface NotEnoughProps {
  /** What is being counted, as it reads mid-sentence: "reviews of mature cards". */
  what: string;
  have: number;
  needed: number;
  testId?: string;
  /** An extra sentence: why these reviews and not others. */
  children?: ReactNode;
}

export function NotEnough({ what, have, needed, testId, children }: NotEnoughProps) {
  const short = Math.max(0, needed - have);
  return (
    <div data-testid={testId} className="rounded-lg border border-dashed border-border p-4">
      <p className="text-sm font-medium">Not enough {what} yet.</p>
      <p className="mt-1 text-sm text-muted">
        This needs about {formatCount(needed)}; you have {formatCount(have)}
        {short > 0 ? <> — {formatCount(short)} to go</> : null}.
      </p>
      {children ? <p className="mt-2 text-sm text-muted">{children}</p> : null}
    </div>
  );
}

/**
 * The other empty state: a *count* that is simply zero.
 *
 * Counts need no threshold (`lib/stats/thresholds.ts`) — they are exact at any
 * size — so when there is nothing to draw the honest thing is to say what is
 * missing, not to draw an axis over no data or to claim a floor that does not
 * apply.
 */
export function EmptyNote({
  children,
  testId,
}: {
  children: ReactNode;
  testId?: string;
}) {
  return (
    <p data-testid={testId} className="rounded-lg border border-dashed border-border p-4 text-sm text-muted">
      {children}
    </p>
  );
}

export interface StatTileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  testId?: string;
  className?: string;
}

/**
 * Label, value, one line of caption. Proportional figures on the value: at tile
 * size `tabular-nums` gives `121` the width of `000` and reads loose.
 */
export function StatTile({ label, value, hint, testId, className }: StatTileProps) {
  return (
    <div className={cn('min-w-0', className)}>
      <p className="text-xs tracking-wide text-muted uppercase">{label}</p>
      <p data-testid={testId} className="text-2xl font-semibold">
        {value}
      </p>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export interface TableViewProps {
  /** What the table holds — "all 60 days", "every bucket". */
  label: string;
  head: readonly string[];
  rows: readonly {
    key: string;
    cells: readonly ReactNode[];
    testId?: string;
    data?: Record<string, string>;
  }[];
  testId?: string;
}

export function TableView({ label, head, rows, testId }: TableViewProps) {
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-sm text-muted">{label}</summary>
      <div className="mt-2 max-h-64 overflow-y-auto">
        <table data-testid={testId} className="w-full text-sm tabular-nums">
          <thead>
            <tr className="text-left text-xs text-muted uppercase">
              {head.map((cell, index) => (
                <th
                  key={cell}
                  scope="col"
                  className={cn('py-1 font-medium', index > 0 && 'text-right')}
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} data-testid={row.testId} {...row.data} className="border-t border-border">
                {row.cells.map((cell, index) => (
                  <td
                    key={index}
                    className={cn('py-1', index > 0 && 'text-right')}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export interface LegendItem {
  label: string;
  color: string;
  /** `rect` for bars and areas, `line` for lines — mirror the mark. */
  shape?: 'rect' | 'line' | 'dot';
}

/** Always present for two or more series; never for one (the title names it). */
export function Legend({ items }: { items: readonly LegendItem[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span
            aria-hidden
            style={{ background: item.color }}
            className={cn(
              'inline-block shrink-0',
              item.shape === 'line' && 'h-0.5 w-4 rounded-full',
              item.shape === 'dot' && 'h-2 w-2 rounded-full',
              (item.shape ?? 'rect') === 'rect' && 'h-2.5 w-2.5 rounded-[2px]',
            )}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export interface TooltipState {
  /** Position in SVG user units; the wrapper converts to a percentage. */
  x: number;
  y: number;
  title: string;
  lines: readonly { label: string; value: string; color?: string }[];
}

/**
 * The hover/focus readout. Positioned as a percentage of the viewBox, which is
 * exact because the SVG scales uniformly (`width:100%; height:auto`), and it
 * costs no layout measurement on a resize.
 *
 * Values lead, labels follow: the reader already knows which series they are
 * pointing at and wants the number.
 */
export function ChartTooltip({
  tooltip,
  width,
  height,
}: {
  tooltip: TooltipState | null;
  width: number;
  height: number;
}) {
  if (!tooltip) return null;
  const left = (tooltip.x / width) * 100;
  const top = (tooltip.y / height) * 100;
  // Flip to the left of the pointer past the midline so the card never leaves
  // the chart; nothing here is interactive, so the transform is safe.
  const flip = left > 55;
  return (
    <div
      role="status"
      data-testid="chart-tooltip"
      style={{
        left: `${left}%`,
        top: `${top}%`,
        transform: `translate(${flip ? 'calc(-100% - 10px)' : '10px'}, -50%)`,
      }}
      className="pointer-events-none absolute z-10 max-w-[60%] rounded-md border border-border bg-surface px-2 py-1.5 text-xs shadow-sm"
    >
      <p className="text-muted">{tooltip.title}</p>
      {tooltip.lines.map((line) => (
        <p key={line.label} className="flex items-center gap-1.5 whitespace-nowrap">
          {line.color ? (
            <span
              aria-hidden
              style={{ background: line.color }}
              className="inline-block h-0.5 w-3 rounded-full"
            />
          ) : null}
          <span className="font-semibold tabular-nums">{line.value}</span>
          <span className="text-muted">{line.label}</span>
        </p>
      ))}
    </div>
  );
}

/** A chart frame: the positioning context the tooltip is placed inside. */
export function ChartFrame({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('viz relative', className)}>{children}</div>;
}

/** Shared hover state, so every chart handles pointer and focus the same way. */
export function useTooltip() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const id = useId();
  return { tooltip, setTooltip, id };
}
