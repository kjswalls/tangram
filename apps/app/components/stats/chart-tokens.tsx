/**
 * The chart palette (Phase 8, `/stats`; re-derived at core.md C0).
 *
 * Tangram's own tokens (`app/tokens.css`) are a UI palette, not a data one, and
 * the accents fail the data-viz gates outright at the values the UI wears: the
 * jade `--lookup` #0f766e sits below the OKLCH chroma floor (0.086) so it reads
 * as gray in a small mark, and its dark twin sits above the dark lightness
 * band. These are the palette's own hues stepped until they pass — C0 requires
 * this file to stay a SEPARATE palette and to be re-derived from the new
 * accents rather than merged into the UI tokens.
 *
 * What C0 changed, and what it did not. The warm series is now the Inkstone
 * vermillion `#b93a26` itself, replacing an unrelated orange; the jade series
 * and the stability ramp are unchanged, because the palette's jade `--lookup`
 * is the same #0f766e the old `--accent` was, so there was nothing to
 * re-derive. Validated, not eyeballed (Viénot 1999 dichromat simulation,
 * CIEDE2000):
 *
 *   series pair, light on #fffdf9: worst adjacent CVD dE 26.8 (protan), 31.9
 *   (deutan), 70.6 (tritan), normal-vision dE 55.9, contrast 3.69:1 and 5.59:1
 *   — all PASS, and every figure is better than the pair this replaced
 *   (protan 20.5, contrast 3.15:1).
 *   series pair, dark on #201d16: worst CVD dE 24.8, normal-vision dE 54.8,
 *   contrast 5.54:1 and 4.33:1 — PASS.
 *   stability ramp (ordinal, 6 steps): monotone lightness, every adjacent dL
 *   >= 0.06 — unchanged and still PASS in both modes.
 *
 * The ramp is one hue light->dark in light mode and dark->light in dark mode:
 * a sequential scale anchors at the surface, so it has to flip with it.
 *
 * Chrome (grid, axis, ink) is wired to the app's own tier-2 tokens, so the
 * charts follow the page rather than carrying a second theme. `--viz-surface`
 * is the card's background, which is what the 2px gaps and rings are painted
 * in. The dark selectors mirror `app/tokens.css`: dark is an explicit choice,
 * never the default (wave-zero.md §10c).
 */

const CSS = `
.viz {
  --viz-surface: var(--surface);
  --viz-grid: var(--border);
  --viz-axis: var(--muted);
  --viz-ink: var(--ink);
  --viz-muted: var(--muted);
  --viz-s1: #0d9488;
  --viz-s2: #b93a26;
  --viz-ramp-1: #5ac8b4;
  --viz-ramp-2: #43b4a1;
  --viz-ramp-3: #2aa08e;
  --viz-ramp-4: #168c7b;
  --viz-ramp-5: #0e7869;
  --viz-ramp-6: #076457;
}
:root[data-theme='dark'] .viz {
  --viz-s1: #12a695;
  --viz-s2: #d95926;
  --viz-ramp-1: #128272;
  --viz-ramp-2: #1d9886;
  --viz-ramp-3: #3cae9b;
  --viz-ramp-4: #55c3b0;
  --viz-ramp-5: #6ddac6;
  --viz-ramp-6: #84f0dc;
}
@media (prefers-color-scheme: dark) {
  :root[data-theme='system'] .viz {
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
.viz .viz-plot:focus-visible { outline: 2px solid var(--lookup); outline-offset: 2px; }
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
