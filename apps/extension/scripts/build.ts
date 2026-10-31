/**
 * `pnpm -F extension build` → `dist/`, which Chrome loads unpacked
 * (chrome://extensions → Developer mode → Load unpacked → apps/extension/dist).
 *
 * Content scripts can't be ES modules, so each entry is bundled on its own as
 * an IIFE; the service worker is a module. `@/…` resolves into apps/app, which
 * is how the extension shares Tangram's segmenter and pinyin code.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { context, type BuildOptions } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

const dict = resolve(root, 'public/dict.json');
if (!existsSync(dict)) {
  console.error('public/dict.json is missing: run `pnpm data` at the workspace root, then `pnpm -F extension dict`.');
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(resolve(dist, 'icons'), { recursive: true });

const shared: BuildOptions = {
  bundle: true,
  target: 'chrome111',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.css': 'text' },
  alias: { '@': resolve(root, '../app') },
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
};

const entries: [string, string, 'iife' | 'esm'][] = [
  ['src/background/index.ts', 'background.js', 'esm'],
  ['src/content/index.ts', 'content.js', 'iife'],
  ['src/page/youtube.ts', 'page-youtube.js', 'iife'],
];

const contexts = await Promise.all(
  entries.map(([entry, out, format]) =>
    context({ ...shared, entryPoints: [resolve(root, entry)], outfile: resolve(dist, out), format }),
  ),
);

copyFileSync(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'));
copyFileSync(dict, resolve(dist, 'dict.json'));
copyFileSync(resolve(root, '../../data/ATTRIBUTION.md'), resolve(dist, 'ATTRIBUTION.md'));
for (const size of [16, 48, 128]) {
  copyFileSync(resolve(root, `public/icons/${size}.png`), resolve(dist, `icons/${size}.png`));
}

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('watching… reload the extension in chrome://extensions after a change to the manifest');
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
