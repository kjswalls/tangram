/**
 * "Keyboard only, no pointer" is a claim, so it is checked (docs/plans/web.md
 * W8, criterion 4).
 *
 * The criterion says the Playwright proof must reach every tab and every
 * primary action **with the keyboard and no pointer**. A spec can satisfy that
 * on the day it is written and quietly stop satisfying it the first time
 * somebody reaches for a convenient `.click()` to get past a step — and the
 * test would still pass, because clicking works. There is no CI here
 * (CLAUDE.md), so the rule is a unit test or it is nothing.
 *
 * `locator.press()` is refused along with the pointer calls, and that is not
 * pedantry: it focuses the element for you before sending the key, which is
 * precisely the half of "can a keyboard user get there" that the criterion is
 * about. `page.keyboard.*` is the allowed path.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const spec = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'tests',
  'e2e',
  'core',
  'keyboard.spec.ts',
);

/** Comments stripped: the header explains what it refuses, by name. */
function body(): string {
  return readFileSync(spec, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('tests/e2e/core/keyboard.spec.ts', () => {
  it('exists and actually drives the keyboard', () => {
    const source = body();
    expect(source).toContain('page.keyboard.press');
    expect(source).toContain('page.keyboard.type');
    // Non-vacuity: a file that lost its tests would pass every ban below.
    expect(source.match(/\btest\(/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });

  it('uses no pointer, anywhere', () => {
    const source = body();
    const banned = [
      /\.click\(/,
      /\.dblclick\(/,
      /\.tap\(/,
      /\.hover\(/,
      /page\.mouse\./,
      /page\.touchscreen\./,
      /\.dragTo\(/,
      /dispatchEvent\(\s*['"](?:click|pointer|mouse|touch)/,
    ];
    for (const pattern of banned) {
      expect(source, `${pattern} appears in the keyboard-only spec`).not.toMatch(pattern);
    }
  });

  it('reaches for no helper that could be hiding one', () => {
    // The guard greps this file and nothing else, so a pointer call could move
    // into a helper and take the claim with it. Raised by the adversarial
    // review. The three modules below are the ones it may import, and the only
    // pointer among them is `dict.ts`'s install fixture — which the spec's own
    // header declares as setup, and which exists because there is no lookup box
    // to put focus in until the dictionary is there. A fourth import is a
    // decision somebody has to make on purpose.
    const imports = [...body().matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual(['../dict', '../p2/fixtures', '../p3/helpers']);
  });

  it('does not let a locator focus an element for it', () => {
    const source = body();
    // `locator.press()` and `locator.focus()` both skip the tab order.
    expect(source).not.toMatch(/getByTestId\([^)]*\)\.(press|focus)\(/);
    expect(source).not.toMatch(/locator\([^)]*\)\.(press|focus)\(/);
  });
});
