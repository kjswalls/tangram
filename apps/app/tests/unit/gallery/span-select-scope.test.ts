/**
 * C5a touches no production reader file (docs/plans/core.md C5a).
 *
 * **This is the criterion `ios.md` I2 is actually relying on**, and C5a says to
 * assert it rather than intend it: I2 loads the harness on a physical device to
 * answer STACK register #1, and `ios.md` §4.4 states that no C5b production file
 * may land before I2 answers. One phase gates the other in each direction unless
 * the harness is separable — so it is separable, and this is what keeps it that
 * way after the commit that made it true.
 *
 * The commit's own `git diff --name-only` is in HANDOFF.md. What a test can hold
 * is the durable half: the harness's import graph, and the absence of the files
 * C5a names as C5b's.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const HARNESS = join(appRoot, 'components', 'gallery', 'span-select-harness.tsx');
const ROUTE = join(appRoot, 'src', 'routes', 'span-select.tsx');

/** Every module specifier a file imports from. */
function imports(path: string): string[] {
  const source = readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

describe('the drag-select harness is separable', () => {
  it('imports nothing from the reader, the reader stores, or lib/reader', () => {
    const forbidden = /components\/reader\/|lib\/stores\/|lib\/reader\//;
    for (const file of [HARNESS, ROUTE]) {
      const offenders = imports(file).filter((specifier) => forbidden.test(specifier));
      expect(offenders, file).toEqual([]);
    }
  });

  it('imports `<HanziText>` and nothing else from components/hanzi', () => {
    // C5a's design is delegated container handlers plus `caretRangeFromPoint`
    // hit-testing into whatever DOM is underneath, so it needs **no prop and no
    // edit** on `<HanziText>` — which C3 already ships. Rendering one is the
    // point: a harness over different markup would measure a different thing.
    const hanzi = imports(HARNESS).filter((specifier) => specifier.includes('components/hanzi'));
    expect(hanzi).toEqual(['@/components/hanzi/hanzi-text']);
  });

  it('does not create the files C5a names as C5b’s', () => {
    // C5a's Files list is the enforcement, in its own words. These two are the
    // production modules the harness's code is promoted into, later, by C5b.
    for (const path of [
      'components/hanzi/use-span-select.ts',
      'components/hanzi/span-clipboard.ts',
    ]) {
      expect(existsSync(join(appRoot, path)), path).toBe(false);
    }
  });

  it('lives under components/gallery, so it leaves a production build', () => {
    // The gallery and this harness share `src/routes.tsx`'s build-mode guard;
    // `tests/e2e/core/gallery-excluded.spec.ts` proves the exclusion.
    expect(existsSync(HARNESS)).toBe(true);
    expect(HARNESS).toContain(join('components', 'gallery'));
  });
});
