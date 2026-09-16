/**
 * The drag-select harness and the production hook, after C5b.
 *
 * **C5a's version of this file asserted the opposite of two things below, and
 * that was right at the time.** C5a's whole enforcement was "touch no
 * production reader file": `ios.md` I2 loads the harness on a physical device
 * to answer STACK register #1, and no C5b production file could land before it
 * answered. `wave-zero.md` §10d has since read the report at its source — the
 * crash is fixed in iOS 26 beta 7, it does not reproduce under Xcode 26, and
 * its stack trace is in `UIEditMenuInteraction`, the native selection gesture
 * this design replaces — so C5b is unblocked and the promotion has happened.
 *
 * What survives the change is the property I2 actually needs, and it is
 * stronger now, not weaker:
 *
 *  - the harness still loads **standalone**, importing nothing from the reader,
 *    the reader stores or `lib/reader` — that is what lets it open at one URL
 *    on a device with no app state behind it;
 *  - the harness **drives the production hook** rather than a second copy of
 *    the interaction, which is C5b's own criterion ("a harness that has drifted
 *    from the production hook is worth nothing to `ios.md` on the next device
 *    run"). Asserted by its absence: none of the gesture's machinery may appear
 *    in the harness's own source;
 *  - the import direction stays **one-way**. The harness may import production
 *    modules; no production module may import the harness, or a production
 *    build would carry the whole gallery.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const HARNESS = join(appRoot, 'components', 'gallery', 'span-select-harness.tsx');
const ROUTE = join(appRoot, 'src', 'routes', 'span-select.tsx');
const HOOK = join(appRoot, 'components', 'hanzi', 'use-span-select.ts');
const CLIPBOARD = join(appRoot, 'components', 'hanzi', 'span-clipboard.ts');

/** A file's source with comments stripped — they name these symbols constantly. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Every module specifier a file imports from. */
function imports(path: string): string[] {
  return [...code(path).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

describe('the drag-select harness is separable', () => {
  it('imports nothing from the reader, the reader stores, or lib/reader', () => {
    const forbidden = /components\/reader\/|lib\/stores\/|lib\/reader\//;
    for (const file of [HARNESS, ROUTE]) {
      const offenders = imports(file).filter((specifier) => forbidden.test(specifier));
      expect(offenders, file).toEqual([]);
    }
  });

  it('lives under components/gallery, so it leaves a production build', () => {
    // The gallery and this harness share `src/routes.tsx`'s build-mode guard;
    // `tests/e2e/core/gallery-excluded.spec.ts` proves the exclusion.
    expect(existsSync(HARNESS)).toBe(true);
    expect(HARNESS).toContain(join('components', 'gallery'));
  });
});

describe('the harness drives the production hook (C5b)', () => {
  it('imports it, and the production modules exist', () => {
    expect(existsSync(HOOK)).toBe(true);
    expect(existsSync(CLIPBOARD)).toBe(true);
    expect(imports(HARNESS)).toContain('@/components/hanzi/use-span-select');
  });

  it('keeps no copy of the gesture, the hit-test or the paint', () => {
    /**
     * The assertion C5b's criterion actually needs. A harness that still had
     * its own `pointermove` logic would keep passing every spec in
     * `tests/e2e/core/span-select-harness.spec.ts` while measuring code the
     * reader does not run — which is the failure mode the criterion names, and
     * it is invisible from the outside.
     */
    const source = code(HARNESS);
    for (const symbol of [
      'caretPositionFromPoint',
      'caretRangeFromPoint',
      'setPointerCapture',
      'createTreeWalker',
      'CSS.highlights',
      'onPointerMove',
      'touchAction',
    ]) {
      expect(source, symbol).not.toContain(symbol);
    }
  });

  it('the import direction is one-way: no production module reaches into the gallery', () => {
    for (const file of [HOOK, CLIPBOARD]) {
      expect(imports(file).filter((s) => s.includes('components/gallery')), file).toEqual([]);
    }
  });
});
