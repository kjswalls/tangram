/**
 * The chart palette (Phase 8, `/stats`).
 *
 * Tangram's own tokens (`app/globals.css`) are a UI palette, not a data one, and
 * two of them fail the data-viz gates outright: the jade accent `#0f766e` sits
 * below the OKLCH chroma floor (0.086) so it reads as gray in a small mark, and
 * its dark-mode twin `#5eead4` sits above the dark lightness band (L 0.855).
 * These are the same two hues stepped until they pass — the app's jade one step
 * brighter, and a warm counterpart for the second series — validated rather
 * than eyeballed:
 *
 *   series pair, light on #ffffff: worst adjacent CVD ΔE 10.7, normal-vision
 *   ΔE 27.5, both marks ≥ 3:1 — all checks PASS.
 *   series pair, dark on #1c1c18: CVD ΔE 13.5, normal-vision ΔE 27.3 — PASS.
 *   stability ramp (ordinal, 6 steps): monotone lightness, every adjacent ΔL
 *   ≥ 0.06, surface-nearest step 2.03:1 light / 3.63:1 dark — PASS both modes.
 *
 * The ramp is one hue light→dark in light mode and dark→light in dark mode:
 * a sequential scale anchors at the surface, so it has to flip with it.
 *
 * Chrome (grid, axis, ink) is wired to the app's own tokens, so the charts
 * follow the page rather than carrying a second theme. `--viz-surface` is the
 * card's background, which is what the 2px gaps and rings are painted in.
 */

const CSS = `
.viz {
  --viz-surface: var(--surface);
  --viz-grid: var(--border);
  --viz-axis: var(--muted);
  --viz-ink: var(--foreground);
  --viz-muted: var(--muted);
  --viz-s1: #0d9488;
  --viz-s2: #eb6834;
  --viz-ramp-1: #5ac8b4;
  --viz-ramp-2: #43b4a1;
  --viz-ramp-3: #2aa08e;
  --viz-ramp-4: #168c7b;
  --viz-ramp-5: #0e7869;
  --viz-ramp-6: #076457;
}
@media (prefers-color-scheme: dark) {
  .viz {
    --viz-s1: #12a695;
    --viz-s2: #d95926;
    --viz-ramp-1: #128272;
    --viz-ramp-2: #1d9886;
    --viz-ramp-3: #3cae9b;
    --viz-ramp-4: #55c3b0;
    --viz-ramp-5: #6ddac6;
    --viz-ramp-6: #84f0dc;
  }
}
.viz svg { display: block; width: 100%; height: auto; }
.viz .viz-plot:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

/** The six ordinal steps, in bucket order. Read by the histogram and its key. */
export const RAMP_VARS = [
  'var(--viz-ramp-1)',
  'var(--viz-ramp-2)',
  'var(--viz-ramp-3)',
  'var(--viz-ramp-4)',
  'var(--viz-ramp-5)',
  'var(--viz-ramp-6)',
] as const;

export const SERIES_1 = 'var(--viz-s1)';
export const SERIES_2 = 'var(--viz-s2)';

/**
 * Hoisted once per page by React (`precedence`), so mounting four charts does
 * not mount four copies of it.
 */
export function ChartTokens() {
  return (
    <style href="tangram-stats-viz" precedence="default">
      {CSS}
    </style>
  );
}
