/**
 * PLAN.md §4: "a unit test imports every runtime dependency".
 *
 * The point is not that npm resolved the names — it is that each package actually
 * loads under the app's ESM/jsdom conditions, which is where a wrong export
 * condition or a missing peer shows up. The loader table is checked against
 * `package.json`, so adding a dependency without proving it imports fails here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { appRoot } from '@/lib/server/roots';

const repoRoot = appRoot(dirname(fileURLToPath(import.meta.url)));

const loaders: Record<string, () => Promise<Record<string, unknown>>> = {
  '@anthropic-ai/sdk': () => import('@anthropic-ai/sdk'),
  // The Capacitor set (docs/plans/ios.md I0). These are runtime dependencies on
  // every platform, not only the two native ones: one build ships to three
  // places, so each package's JS half is what the bundle imports and has to load
  // under the app's conditions — every one of these has a web implementation
  // that throws "not implemented" rather than being absent. `@capacitor/ios`
  // carries native sources and podspecs with no importable entry point, so it is
  // asserted below rather than here.
  '@capacitor-community/sqlite': () => import('@capacitor-community/sqlite'),
  '@capacitor-community/text-to-speech': () => import('@capacitor-community/text-to-speech'),
  '@capacitor/app': () => import('@capacitor/app'),
  '@capacitor/core': () => import('@capacitor/core'),
  '@capacitor/keyboard': () => import('@capacitor/keyboard'),
  '@capacitor/splash-screen': () => import('@capacitor/splash-screen'),
  '@capacitor/status-bar': () => import('@capacitor/status-bar'),
  // A workspace package, and worth the same proof as a published one: it is
  // TypeScript source behind an `exports` map, which resolves only because pnpm
  // symlinks it (see its package.json's note on the type-stripping debt). If
  // that ever stops being true, it stops being true here first.
  '@tangram/access': () => import('@tangram/access'),
  // The same, and it became a *runtime* dependency the moment wave-zero.md §5's
  // deliverable 5 moved the eleven `lib/ai/**` modules into it: the ask panel,
  // the card back and the three model routes all import it now, so it moved out
  // of devDependencies and has to prove it loads. The specifier is the package
  // barrel rather than the package root: `exports["."]` still points at the
  // frozen `schemas.ts`, which has no imports and so proves almost nothing,
  // while `index.ts` evaluates provider, fake, anthropic, prompts, ground and
  // cache-key — the half of the package with the SDK and the module cycle in
  // it. It does NOT reach deadline, examples, recall, retrieve or schemas: the
  // barrel does not re-export them and this table takes one entry per package.
  // Those are covered by the suites that import them directly under
  // tests/unit/ai/**, which is where a broken subpath in `exports` surfaces.
  '@tangram/ai': () => import('@tangram/ai/index'),
  // The OPFS dictionary's wasm (docs/plans/data.md D4). The module factory is
  // all that is imported here — initialising it would fetch and instantiate
  // 869 KB of wasm, which is the worker's job and not a dependency check's.
  '@sqlite.org/sqlite-wasm': () => import('@sqlite.org/sqlite-wasm'),
  clsx: () => import('clsx'),
  dexie: () => import('dexie'),
  'dexie-react-hooks': () => import('dexie-react-hooks'),
  'lucide-react': () => import('lucide-react'),
  'pinyin-pro': () => import('pinyin-pro'),
  react: () => import('react'),
  'react-dom': () => import('react-dom/client'),
  'react-router': () => import('react-router'),
  'ts-fsrs': () => import('ts-fsrs'),
  zod: () => import('zod'),
  zustand: () => import('zustand'),
};

function manifest(): { dependencies: Record<string, string>; devDependencies: Record<string, string> } {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
}

describe('runtime dependencies', () => {
  it('covers every dependency package.json declares', () => {
    expect(Object.keys(loaders).sort()).toEqual(Object.keys(manifest().dependencies).sort());
  });

  it.each(Object.keys(loaders))('imports %s', async (name) => {
    const mod = await loaders[name]();
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });
});

/**
 * Two Capacitor packages are not runtime dependencies and must not drift into
 * `dependencies` or out of the manifest (`docs/plans/ios.md` I0).
 *
 * `@capacitor/ios` ships **no importable JavaScript entry point** — no `main`,
 * no `module`, no `exports`; its `files` are the native sources, two podspecs
 * and `pods_helpers.rb`. `@capacitor/android` (`docs/plans/android.md` A1) is
 * the same shape and is here for the same reason: its `files` are
 * `capacitor/build.gradle`, three lint/proguard files and `capacitor/src/main/`,
 * with no `main`, `module`, `exports` or `types` at all. (It does carry JS: `Capacitor/Capacitor/assets/
 * native-bridge.js`, 53 KB, which the native runtime injects into the WebView
 * and which `lib/platform/native.ts` cites — but nothing ever resolves it
 * through node.) So it cannot satisfy the import check above. The CLI finds it
 * by plain node resolution (`resolveNode(rootDir, '@capacitor/ios',
 * 'package.json')`), which does not care which section declares it.
 *
 * **What this does NOT rest on:** an earlier draft of this comment claimed
 * `cap sync` discovers plugins from `dependencies` only. It does not.
 * `@capacitor/cli` 8.5.2 `dist/plugin.js` `getDependencies()` concatenates
 * `dependencies` **and** `devDependencies`, so the section a plugin sits in
 * does not affect the native project at all. The claim came from a
 * case-sensitive grep for `dependencies`, which does not match
 * `devDependencies`; it is recorded here because a plausible false fact about a
 * build tool outlives the person who wrote it.
 *
 * The real rule is the ordinary one: these packages export JavaScript that the
 * single web/native bundle imports at runtime, so they are runtime
 * dependencies, and the import check above is what proves they load.
 */
describe('the Capacitor packages that are not runtime dependencies', () => {
  it('keeps the platform packages and the CLI out of dependencies', () => {
    const pkg = manifest();
    for (const name of ['@capacitor/ios', '@capacitor/android', '@capacitor/cli']) {
      expect(pkg.dependencies[name], `${name} must not be a runtime dependency`).toBeUndefined();
      expect(pkg.devDependencies[name], `${name} must be a devDependency`).toBeDefined();
    }
  });

  it('keeps every plugin in dependencies, with its JS half proved to load', () => {
    const pkg = manifest();
    for (const name of [
      '@capacitor/core',
      '@capacitor/app',
      '@capacitor/keyboard',
      '@capacitor/splash-screen',
      '@capacitor/status-bar',
      '@capacitor-community/sqlite',
      '@capacitor-community/text-to-speech',
    ]) {
      expect(pkg.dependencies[name], `${name} must be in dependencies`).toBeDefined();
    }
  });
});
