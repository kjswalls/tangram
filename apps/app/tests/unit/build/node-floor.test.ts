// @vitest-environment node
/**
 * The Node floor, and the two ways it could quietly stop being true.
 *
 * `.npmrc`'s `engine-strict=true` was retired because it honoured a pin that was
 * not a requirement (`cedict-json`'s bare `node: "22"`, on a package we never
 * execute) and thereby made every Vercel build impossible: React Router needs
 * >= 22.22, Vercel's 22.x image is below it, and 24 was refused by the pin.
 * `scripts/check-node.ts` replaced it. There is no CI (`CLAUDE.md`), so the
 * replacement is held here or nowhere.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NODE_FLOOR, satisfiesFloor } from '../../../../../scripts/check-node';
import { workspaceRoot } from '@/lib/server/roots';

const require = createRequire(import.meta.url);

describe('the Node floor', () => {
  /**
   * The floor is not ours to choose — it is whatever React Router declares. If
   * an upgrade moves it, this fails rather than letting the constant drift into
   * a number nothing supports.
   */
  it('is exactly what react-router declares', () => {
    const manifest = require(require.resolve('react-router/package.json')) as {
      version: string;
      engines?: { node?: string };
    };
    expect(manifest.engines?.node).toBe(`>=${NODE_FLOOR}`);
  });

  it('accepts the Node this repository targets, and Node 24', () => {
    expect(satisfiesFloor('v22.22.0')).toBe(true);
    expect(satisfiesFloor('v22.22.2')).toBe(true);
    expect(satisfiesFloor('v24.19.0')).toBe(true);
    expect(satisfiesFloor('v24.21.0')).toBe(true);
  });

  it('rejects everything below it, including the near misses', () => {
    expect(satisfiesFloor('v22.21.1')).toBe(false);
    expect(satisfiesFloor('v22.9.0')).toBe(false);
    expect(satisfiesFloor('v20.19.0')).toBe(false);
    expect(satisfiesFloor('v18.20.4')).toBe(false);
  });

  /**
   * The check is worthless if nothing runs it. `engine-strict` ran on every
   * install; this runs first in the build, so a wrong Node fails before the
   * 43 MB data build rather than after it.
   */
  it('runs first in pnpm build', () => {
    const pkg = JSON.parse(readFileSync(join(workspaceRoot(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const script of ['build', 'build:e2e']) {
      expect(pkg.scripts[script]).toMatch(/^pnpm run node:check &&/);
    }
    expect(pkg.scripts['node:check']).toBe('tsx scripts/check-node.ts');
  });

  /**
   * And engine-strict must stay off. Turning it back on restores the deadlock —
   * `cedict-json` would reject the only Node a Vercel build can use.
   */
  it('does not re-enable engine-strict', () => {
    const npmrc = readFileSync(join(workspaceRoot(), '.npmrc'), 'utf8');
    const active = npmrc
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(active).not.toMatch(/engine-strict\s*=\s*true/);
  });
});
