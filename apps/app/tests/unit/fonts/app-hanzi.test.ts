/**
 * The hanzi the app draws as **chrome** must be in the first slice
 * (docs/plans/web.md W6).
 *
 * This is a measured defect, not a hypothetical. The first build that shipped
 * these fonts cut every slice by jieba frequency, which put 巧 and 板 — two of
 * the three characters in the wordmark beside "Tangram", rendered on *every*
 * screen — in slices 3 and 7. A first paint of any route therefore pulled
 * **607 KB of hanzi to draw three characters of branding**, and nothing failed:
 * the coverage check passed, the text rendered, the budget was just six times
 * what it should be.
 *
 * So the wordmark's characters are pinned into the app's own text set
 * (`scripts/font-charset.ts` `APP_HANZI`), and this test fails if the chrome
 * grows a character that list does not have.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appRoot, dirOf, workspaceRoot } from '@/lib/server/roots';

const here = dirOf(import.meta.url);
const root = workspaceRoot(here);
const app = appRoot(here);

/**
 * The directories whose text is on screen whatever route the learner is on: the
 * shell around every page, the primitives it is built from, and the progress
 * square that carries the same three characters. A screen's *content* is
 * dictionary text and is not this test's business.
 */
const CHROME = ['components/shell', 'components/ui', 'components/practice'];

function hanziIn(dir: string, out = new Map<string, Set<string>>()): Map<string, Set<string>> {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      hanziIn(path, out);
      continue;
    }
    if (!/\.(tsx?|css)$/.test(name)) continue;
    for (const ch of readFileSync(path, 'utf8')) {
      const cp = ch.codePointAt(0) ?? 0;
      const cjk =
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0x2_0000 && cp <= 0x3_ffff);
      if (cjk) out.set(ch, (out.get(ch) ?? new Set()).add(path.replace(`${app}/`, '')));
    }
  }
  return out;
}

describe("the app's own hanzi ship in the first slice", () => {
  it('the shell and the primitives use no hanzi outside APP_HANZI', async () => {
    const { APP_HANZI } = (await import(
      /* @vite-ignore */ join(root, 'scripts', 'font-charset.ts')
    )) as typeof import('../../../../../scripts/font-charset');
    const allowed = new Set([...APP_HANZI]);
    const found = new Map<string, Set<string>>();
    for (const dir of CHROME) hanziIn(join(app, dir), found);

    const unlisted = [...found]
      .filter(([ch]) => !allowed.has(ch))
      .map(([ch, files]) => `${ch} (U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()}) in ${[...files].join(', ')}`);
    expect(
      unlisted,
      'a hanzi on every screen that is not in APP_HANZI lands in a frequency slice and ' +
        'costs a first paint hundreds of KB — add it to scripts/font-charset.ts and re-run ' +
        '`pnpm font:subset`',
    ).toEqual([]);
    expect(found.size).toBeGreaterThan(0);
  });

  it('every APP_HANZI character is in the first shipped hanzi slice', async () => {
    const { APP_HANZI } = (await import(
      /* @vite-ignore */ join(root, 'scripts', 'font-charset.ts')
    )) as typeof import('../../../../../scripts/font-charset');
    const { parseFontFaces, expand } = (await import(
      /* @vite-ignore */ join(root, 'scripts', 'font-css.ts')
    )) as typeof import('../../../../../scripts/font-css');

    const faces = parseFontFaces(readFileSync(join(app, 'src', 'styles', 'fonts.css'), 'utf8'));
    const first = faces.find((face) => face.family === 'Noto Serif SC');
    expect(first, 'no Noto Serif SC @font-face at all').toBeDefined();
    const claimed = expand(first?.unicodeRange ?? []);
    for (const ch of APP_HANZI) {
      expect(claimed.has(ch.codePointAt(0) ?? 0), `${ch} is not in ${first?.src}`).toBe(true);
    }
  });
});
