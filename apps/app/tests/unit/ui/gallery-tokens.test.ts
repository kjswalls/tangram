/**
 * The gallery's token names, checked through TypeScript (docs/plans/core.md C1).
 *
 * `tests/unit/ui/tokens.test.ts` asserts that every `var(--…)` in app source
 * names a token `app/tokens.css` declares — by regex, over the source text. The
 * gallery reads its swatches and its contrast pairs through
 * `var(${token})` interpolation, which that regex cannot see: the literal has
 * no `--` after the paren. So a swatch naming a token that no longer exists
 * would render as a transparent square, and a contrast row naming one would
 * silently measure the *inherited* colour — which parses as a colour, so even
 * the runtime guard in `luminance()` would not notice.
 *
 * This closes that hole from the other side: the same two lists, reached as
 * values rather than as text.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CONTRAST_PAIRS, SWATCHES } from '@/components/gallery/gallery';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tokens = readFileSync(join(appRoot, 'app', 'tokens.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** Every custom property `app/tokens.css` declares anywhere. */
const declared = new Set(
  [...tokens.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1]),
);

describe('the gallery names only tokens that exist', () => {
  it('declares something to compare against', () => {
    expect(declared.size).toBeGreaterThan(20);
  });

  it.each(SWATCHES.map((swatch) => swatch.token))('swatch %s is declared', (token) => {
    expect(declared.has(token), `${token} is not declared in app/tokens.css`).toBe(true);
  });

  it('every contrast pair names two declared tokens', () => {
    for (const pair of CONTRAST_PAIRS) {
      expect(declared.has(pair.fg), `${pair.fg} is not declared`).toBe(true);
      expect(declared.has(pair.bg), `${pair.bg} is not declared`).toBe(true);
    }
  });

  it('the swatch list covers every tier-2 colour token, so none goes unreviewed', () => {
    const tier1 = `--${'t1'}-`;
    const tier2 = [...declared].filter(
      (token) =>
        !token.startsWith(tier1) &&
        !token.startsWith('--color-') &&
        !token.startsWith('--font-') &&
        !token.startsWith('--r-') &&
        !token.startsWith('--breakpoint-'),
    );
    const shown = new Set(SWATCHES.map((swatch) => swatch.token));
    expect([...tier2].filter((token) => !shown.has(token))).toEqual([]);
  });
});
