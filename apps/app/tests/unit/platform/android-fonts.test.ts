/**
 * "There is no Android font pipeline" (`docs/plans/android.md` A3), as a check
 * rather than as a sentence.
 *
 * A3 closes the full-face option in favour of `web.md` W6's `unicode-range`
 * subsets, and its argument is mechanical: W6 puts the faces under
 * `apps/app/src/fonts/` and references them from `src/styles/fonts.css`, so Vite
 * emits them into the hashed asset directory, so they are in `dist/`, so
 * **Capacitor inherits the web's fonts and Android needs no font work at all**.
 * `cap sync` copies the whole of `webDir` into
 * `android/app/src/main/assets/public/`, and
 * `tests/unit/platform/capacitor-config.test.ts` already pins `webDir` to Vite's
 * `build.outDir`, which is the other half of that chain.
 *
 * What is left to go wrong is a builder under deadline putting a `.ttf` into the
 * native tree — the "second set of files, a second `@font-face` block
 * conditioned on the native platform, and a build step to place them" that A3
 * says must not exist. That is what this file fails on. A3's own words: if the
 * full face ever comes back it comes back as a **`web.md` W6 change**, shipped in
 * `dist/`, not as an Android pipeline built here.
 *
 * Everything else in A3 needs hardware. The Japanese-locale glyph check, the
 * bold check, the per-device screenshot diff and the package-size delta are all
 * in `HANDOFF.md` as a device checklist, and A3 is additionally blocked on W6,
 * which has not landed on any branch: there are no subset files to measure.
 *
 * The `lang="zh-Hans"` root declaration that criterion 2 verifies on a device is
 * already asserted by `tests/unit/pwa/manifest.test.ts`; it is not duplicated
 * here.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appRoot } from '@/lib/server/roots';

const APP = appRoot(import.meta.dirname);
const ANDROID = resolve(APP, 'android');

const FONT_EXTENSIONS = ['.woff', '.woff2', '.ttf', '.otf', '.ttc', '.eot'];

/**
 * `assets/public/` is `cap sync`'s copy of `dist/` — gitignored, regenerated on
 * every sync, and the *right* place for a font to appear. It is skipped because
 * finding a font there is the success case, not the failure.
 */
const SYNC_OUTPUT = join('app', 'src', 'main', 'assets', 'public');

/**
 * Generated trees, skipped by name.
 *
 * **Without this the test fails on the builder's machine and nowhere else.** A
 * plain `./gradlew assembleDebug` writes merged assets — the synced web fonts
 * among them — into `android/app/build/intermediates/`, which is gitignored and
 * is not source. The subject here is what this repository *ships*, so the walk
 * covers exactly that and nothing a build produced.
 */
const GENERATED = new Set(['build', '.gradle', 'capacitor-cordova-android-plugins']);

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (GENERATED.has(entry)) continue;
    const full = join(dir, entry);
    const rel = relative(ANDROID, full);
    if (rel === SYNC_OUTPUT || rel.startsWith(`${SYNC_OUTPUT}/`)) continue;
    if (statSync(full).isDirectory()) walk(full, found);
    else if (FONT_EXTENSIONS.some((extension) => entry.toLowerCase().endsWith(extension))) found.push(rel);
  }
  return found;
}

describe('the Android package has no font pipeline of its own', () => {
  it('ships no font file inside the native tree', () => {
    expect(walk(ANDROID)).toEqual([]);
  });
});
