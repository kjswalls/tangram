/**
 * The workspace invariants (docs/plans/web.md W0, docs/plans/wave-zero.md §1).
 *
 * W0 states these as things to check by hand after the move. They are here
 * instead because the failure they guard is the one that *passes* every other
 * test: `scripts/build-data.ts` writes where it resolves and `lib/dict/load.ts`
 * reads where it resolves, so if both drift to `apps/app/data/` they agree with
 * each other, the dictionary answers, the suite is green, and the invariant
 * three deployables depend on is gone. There is no CI, so a rule that wants
 * enforcement is a unit test.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appRoot, dataDir, workspaceRoot } from '@/lib/server/roots';

const APP = appRoot(import.meta.dirname);
const WORKSPACE = workspaceRoot(import.meta.dirname);

describe('the workspace layout', () => {
  it('has two distinct roots, and the app is inside the workspace', () => {
    expect(APP).not.toBe(WORKSPACE);
    expect(APP).toBe(resolve(WORKSPACE, 'apps/app'));
  });

  it('declares both apps/* and packages/* — W4 and backend.md write into packages/', () => {
    const yaml = readFileSync(resolve(WORKSPACE, 'pnpm-workspace.yaml'), 'utf8');
    expect(yaml).toMatch(/^\s*-\s*'?apps\/\*'?\s*$/m);
    expect(yaml).toMatch(/^\s*-\s*'?packages\/\*'?\s*$/m);
  });

  it('keeps data/, scripts/, docs/, PLAN.md, HANDOFF.md and CLAUDE.md at the workspace root', () => {
    // wave-zero.md §1 and STACK.md §5 both put `scripts/` here, against
    // web.md W0's own Files list. The ruling governs; see HANDOFF.md.
    for (const entry of ['data', 'scripts', 'docs', 'PLAN.md', 'HANDOFF.md', 'CLAUDE.md']) {
      expect(existsSync(resolve(WORKSPACE, entry)), entry).toBe(true);
    }
    expect(existsSync(resolve(APP, 'scripts')), 'apps/app/scripts must not exist').toBe(false);
  });

  it('type-checks and lints the root scripts/, which left the app\'s project', () => {
    // Before W0 these four files were inside `apps/app`'s tsconfig and eslint,
    // and `next build` typechecked them. Losing that silently is the failure
    // this asserts against.
    expect(existsSync(resolve(WORKSPACE, 'tsconfig.json'))).toBe(true);
    expect(existsSync(resolve(WORKSPACE, 'eslint.config.mjs'))).toBe(true);
    const root = JSON.parse(readFileSync(resolve(WORKSPACE, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    // Root scripts/ AND the app: W1 gave the app its own `tsc --noEmit` once
    // `next build` — the repo's only typechecker until then — went away.
    // Asserted as parts rather than as one literal string, because
    // `backend.md` B0 appends `apps/server` to the same script and a later
    // package will append itself again: what must stay true is that the root
    // typechecks its own `scripts/` AND every package, not the exact spelling.
    // The BARE invocation, not merely the token: `tsc --noEmit -p
    // apps/app/tsconfig.json` contains the token and typechecks the root
    // `scripts/` directory not at all — which is the same silent-coverage-loss
    // this test exists for. The per-package parts stay loose so a new package
    // can append itself.
    expect(root.scripts.typecheck).toMatch(/(^|&&\s*)tsc --noEmit\s*(&&|$)/);
    expect(root.scripts.typecheck).toMatch(/-F app typecheck/);
    expect(root.scripts.build).toMatch(/typecheck/);
    expect(root.scripts.lint).toMatch(/eslint \./);
  });
});

describe('the data directory', () => {
  it('defaults to the WORKSPACE root, not the app, with TANGRAM_DATA_DIR unset', () => {
    const saved = process.env.TANGRAM_DATA_DIR;
    delete process.env.TANGRAM_DATA_DIR;
    try {
      expect(dataDir()).toBe(resolve(WORKSPACE, 'data'));
      expect(dataDir()).not.toBe(resolve(APP, 'data'));
    } finally {
      if (saved !== undefined) process.env.TANGRAM_DATA_DIR = saved;
    }
  });

  it('is honoured from TANGRAM_DATA_DIR, which is the authoritative mechanism', () => {
    const saved = process.env.TANGRAM_DATA_DIR;
    process.env.TANGRAM_DATA_DIR = '/tmp/tangram-data-dir-probe';
    try {
      expect(dataDir()).toBe('/tmp/tangram-data-dir-probe');
    } finally {
      if (saved === undefined) delete process.env.TANGRAM_DATA_DIR;
      else process.env.TANGRAM_DATA_DIR = saved;
    }
  });

  it('is the same directory the generator writes to — the two halves of the trap', () => {
    // The reader is `dataDir()` above. The writer is a separate module with its
    // own resolution, so ask it rather than assuming; `--print-data-dir` exists
    // for this test and does no work.
    const printed = execFileSync(
      resolve(WORKSPACE, 'node_modules/.bin/tsx'),
      [resolve(WORKSPACE, 'scripts/build-data.ts'), '--print-data-dir'],
      // cwd is the APP deliberately: the writer must not be cwd-sensitive.
      { cwd: APP, encoding: 'utf8', env: { ...process.env, TANGRAM_DATA_DIR: '' } },
    ).trim();
    expect(printed).toBe(resolve(WORKSPACE, 'data'));
  });
});

describe('the Node floor', () => {
  it('is >=22.22 at the workspace root — React Router 8 requires it (STACK §2.3)', () => {
    const root = JSON.parse(readFileSync(resolve(WORKSPACE, 'package.json'), 'utf8')) as {
      engines?: { node?: string };
    };
    expect(root.engines?.node).toBe('>=22.22');
  });

  it('is declared identically by the app, so `pnpm -F app` enforces it too', () => {
    const app = JSON.parse(readFileSync(resolve(APP, 'package.json'), 'utf8')) as {
      engines?: { node?: string };
    };
    expect(app.engines?.node).toBe('>=22.22');
  });

  it('is satisfied by the Node running this suite', () => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(22);
    if (major === 22) expect(minor).toBeGreaterThanOrEqual(22);
  });

  /**
   * **This used to assert `engine-strict=true`, and it was right to.** `engines`
   * is a comment unless something enforces it and there is no CI. The instrument
   * changed, not the rule: engine-strict honours every publisher's `engines`,
   * and `cedict-json` pins a bare `node: "22"` on 16 MB of JSON we never
   * execute. That pin refused Node 24 while react-router refused Vercel's 22.x
   * image, so no Node a Vercel build can run satisfied both and every deploy
   * died in `pnpm install`. `scripts/check-node.ts` states the real floor
   * instead, and `tests/unit/build/node-floor.test.ts` holds it — including that
   * it runs first in `pnpm build` and that engine-strict stays off.
   */
  it('is enforced by the floor check, and engine-strict stays off', () => {
    const root = JSON.parse(readFileSync(resolve(WORKSPACE, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(root.scripts.build).toMatch(/^pnpm run node:check &&/);

    const active = readFileSync(resolve(WORKSPACE, '.npmrc'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(active).not.toMatch(/engine-strict\s*=\s*true/);
  });

  it('agrees with .nvmrc', () => {
    expect(readFileSync(resolve(WORKSPACE, '.nvmrc'), 'utf8').trim()).toBe('22.22');
  });
});

describe('the app build does not generate data', () => {
  it("leaves data:ensure to the workspace root's build script", () => {
    const app = JSON.parse(readFileSync(resolve(APP, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const root = JSON.parse(readFileSync(resolve(WORKSPACE, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(app.scripts.build).not.toMatch(/data:ensure/);
    expect(root.scripts.build).toMatch(/data:ensure/);
  });
});
