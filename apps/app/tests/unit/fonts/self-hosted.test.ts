/**
 * W6's acceptance criteria 1 and 3, and the delivery rule underneath both
 * (docs/plans/web.md W6).
 *
 * Three properties, each of which is invisible when it breaks:
 *
 * 1. **Nothing reaches a font CDN.** The plan's `grep` — `grep -rn
 *    "fonts.googleapis\|fonts.gstatic" apps/` returns nothing — as a test, so it
 *    is run rather than remembered. A third origin is unreachable from
 *    Capacitor's `capacitor://localhost` scheme and can never be stored by the
 *    service worker, whose test is `response.type === 'basic'`.
 * 2. **No font lives in `publicDir`.** W3's cache-first rule is a *path prefix*
 *    over `/assets/`. A file under `public/fonts/` keeps its authored name, gets
 *    no content hash, and is matched by rule 2 (wrong prefix) and rule 3 (not a
 *    navigation) — that is, by nothing. It would be re-fetched on every load and
 *    absent offline, and nothing would fail.
 * 3. **The stylesheet is in the module graph.** `src/main.tsx` imports it, so
 *    Vite rewrites each relative `url()` into the hashed asset directory.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appRoot, dirOf, workspaceRoot } from '@/lib/server/roots';

const here = dirOf(import.meta.url);
const root = workspaceRoot(here);
const app = appRoot(here);

const CDN = /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit|fonts\.bunny\.net|cdn\.jsdelivr\.net\/fontsource/;

function sources(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(tsx?|css|html|json|webmanifest|js)$/.test(name)) out.push(path);
  }
  return out;
}

describe('the fonts are self-hosted', () => {
  it('nothing under apps/ names a font CDN', () => {
    const offenders = sources(join(root, 'apps')).filter((path) => {
      // `tests/unit/fonts/` is where the CDN hosts are NAMED — this list, and
      // the mutation case in `coverage.test.ts` that rewrites a `url()` into a
      // gstatic one to prove the parser refuses it. A string in a test that
      // asserts the string must not ship cannot itself be the thing shipping.
      if (path.startsWith(`${here}/`) || path === join(here, 'self-hosted.test.ts')) return false;
      return CDN.test(readFileSync(path, 'utf8'));
    });
    expect(offenders).toEqual([]);
  });

  it('index.html preconnects to nothing', () => {
    const html = readFileSync(join(app, 'index.html'), 'utf8');
    expect(html).not.toMatch(/rel=["'](?:preconnect|dns-prefetch)["']/);
    expect(html).not.toMatch(CDN);
  });

  it('no font file is served out of publicDir', () => {
    const offenders = (function walk(dir: string, out: string[] = []): string[] {
      if (!existsSync(dir)) return out;
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path, out);
        else if (/\.(woff2?|ttf|otf|eot)$/i.test(name)) out.push(path);
      }
      return out;
    })(join(app, 'public'));
    expect(offenders).toEqual([]);
  });

  it('the generated stylesheet is imported by the entry, not linked from the document', () => {
    const main = readFileSync(join(app, 'src', 'main.tsx'), 'utf8');
    expect(main).toMatch(/import ['"]\.\/styles\/fonts\.css['"]/);
    const html = readFileSync(join(app, 'index.html'), 'utf8');
    expect(html).not.toMatch(/fonts\.css/);
  });

  it('every @font-face url() resolves to a file under src/fonts/', async () => {
    const { parseFontFaces } = (await import(
      /* @vite-ignore */ join(root, 'scripts', 'font-css.ts')
    )) as typeof import('../../../../../scripts/font-css');
    const cssPath = join(app, 'src', 'styles', 'fonts.css');
    const faces = parseFontFaces(readFileSync(cssPath, 'utf8'));
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      expect(face.src.startsWith('../fonts/'), face.src).toBe(true);
      expect(existsSync(join(app, 'src', 'fonts', face.src.replace('../fonts/', ''))), face.src).toBe(
        true,
      );
      // `swap` rather than `block`: an offline-first app must paint its text
      // before a 70 KB slice lands, and after the first load the worker serves
      // it from cache anyway.
      expect(face.display).toBe('swap');
    }
  });

  /**
   * Vite inlines any asset under `assetsInlineLimit` as a `data:` URI, and two
   * of the shipped slices are under the 4 KB default. `vite.config.ts` turns
   * that off for `.woff2` and this is what keeps it off: the whole delivery
   * mechanism is "into the hashed asset directory the service worker caches",
   * and a rule with a size hole in it is not that.
   */
  it('vite.config.ts refuses to inline a woff2', () => {
    const config = readFileSync(join(app, 'vite.config.ts'), 'utf8');
    expect(config).toMatch(/assetsInlineLimit/);
    expect(config).toMatch(/\.woff2/);
  });
});
