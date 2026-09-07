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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const loaders: Record<string, () => Promise<Record<string, unknown>>> = {
  '@anthropic-ai/sdk': () => import('@anthropic-ai/sdk'),
  clsx: () => import('clsx'),
  dexie: () => import('dexie'),
  'dexie-react-hooks': () => import('dexie-react-hooks'),
  'lucide-react': () => import('lucide-react'),
  // `next` has no useful root export; the routes' entry point is what must load.
  next: () => import('next/server'),
  'pinyin-pro': () => import('pinyin-pro'),
  react: () => import('react'),
  'react-dom': () => import('react-dom/client'),
  'ts-fsrs': () => import('ts-fsrs'),
  zod: () => import('zod'),
  zustand: () => import('zustand'),
};

describe('runtime dependencies', () => {
  it('covers every dependency package.json declares', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(loaders).sort()).toEqual(Object.keys(pkg.dependencies).sort());
  });

  it.each(Object.keys(loaders))('imports %s', async (name) => {
    const mod = await loaders[name]();
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });
});
