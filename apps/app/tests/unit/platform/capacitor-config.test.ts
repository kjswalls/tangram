/**
 * The Capacitor config's one real invariant: **the CLI resolves everything from
 * `process.cwd()`** (`docs/plans/ios.md` I0, `docs/plans/android.md` §2).
 *
 * `@capacitor/cli` 8.5.2, `dist/config.js`:
 *
 *     const appRootDir = process.cwd();
 *     const conf = await loadExtConfig(appRootDir);   // no upward walk
 *     webDirAbs: resolve(appRootDir, webDir)
 *     platformDirAbs: resolve(rootDir, extConfig.ios?.path ?? 'ios')
 *
 * So the config file's own location buys nothing; what matters is that the CLI
 * is always run with cwd `apps/app/`. Run it from the workspace root instead and
 * `loadExtConfig` finds no file, returns `{}`, and the CLI proceeds with
 * `webDir: 'www'`.
 *
 * **Be precise about which half of that is silent, because an earlier draft of
 * this file was not.** Run from the workspace root, the CLI *does* complain —
 * `checkWebDir` (`dist/common.js`) refuses a `webDir` that is missing or holds
 * no `index.html`, and sync stops with
 * `[error] Could not find the web assets directory: ./www`. Verified by running
 * it, 2026-09-14. What stays silent is **drift between `webDir` and Vite's
 * `build.outDir` while a stale build is still on disk**: `dist/` is gitignored,
 * survives an `outDir` change, and still contains an `index.html`, so
 * `checkWebDir` passes and the sync ships last week's bundle to a phone. That
 * one no CLI check covers, and it is the reason for the `outDir` assertion
 * below. There is no CI (STACK §5.9), so the rule is a unit test.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import capacitorConfig from '@/capacitor.config';
import { appRoot, workspaceRoot } from '@/lib/server/roots';
import viteConfig from '@/vite.config';

const APP = appRoot(import.meta.dirname);
const WORKSPACE = workspaceRoot(import.meta.dirname);

/**
 * Does this npm script end up invoking the Capacitor CLI with the *workspace
 * root* as cwd?
 *
 * Judged by cwd, not by the token: `pnpm -F app cap sync android` is a root
 * script and is correct, because pnpm runs it in `apps/app/`. `android.md` A1
 * adds exactly that kind of line, so a guard that banned the word would fail the
 * sibling plan rather than the mistake. Delegating prefixes are stripped first;
 * whatever still invokes `cap` afterwards is running at the root.
 *
 * Defined once and exercised twice below — by the real manifests, and by a table
 * of commands that pins what it discriminates.
 */
// `pnpm -F app …` delegates the one command it prefixes; `cd apps/app && …`
// delegates the whole `&&`/`||` chain after it, up to the next `;`.
const DELEGATED = /\bpnpm\s+(?:run\s+)?(?:-F|--filter(?:=|\s+))\s*app\b[^&|;]*|\bcd\s+apps\/app\s*&&[^;]*/g;
const INVOKES_CAP = /(^|[\s&|;])(npx\s+)?cap(\s|$)/;

function invokesCapAtRoot(command: string): { hit: boolean; residue: string } {
  const residue = command.replace(DELEGATED, ' ');
  return { hit: INVOKES_CAP.test(residue), residue: residue.trim() };
}

function scriptsOf(pkgDir: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

describe('capacitor.config.ts', () => {
  it('sits beside the package.json whose scripts run the CLI', () => {
    // Same directory, because that directory is the cwd `pnpm -F app` uses.
    expect(existsSync(resolve(APP, 'capacitor.config.ts'))).toBe(true);
    expect(existsSync(resolve(APP, 'package.json'))).toBe(true);
  });

  it('has no rival at the workspace root', () => {
    // A second config at the root would be the one a root-cwd invocation finds,
    // and the two would drift.
    for (const name of ['capacitor.config.ts', 'capacitor.config.js', 'capacitor.config.json']) {
      expect(existsSync(resolve(WORKSPACE, name)), name).toBe(false);
    }
  });

  it("declares webDir 'dist', which is what Vite actually writes", () => {
    expect(capacitorConfig.webDir).toBe('dist');
    // The assertion that matters is not the string but that the two agree:
    // `webDir` is resolved against cwd (= APP) and `outDir` against Vite's root
    // (= APP). If either moves, the CLI copies a directory that is not the build.
    const outDir = (viteConfig as { build?: { outDir?: string } }).build?.outDir;
    expect(outDir).toBeDefined();
    expect(resolve(APP, capacitorConfig.webDir as string)).toBe(resolve(APP, outDir as string));
  });

  it('declares a non-empty reverse-DNS appId and an appName', () => {
    // An absent appId is not an error either: the CLI defaults it to ''.
    expect(capacitorConfig.appId).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/);
    expect(capacitorConfig.appName).toBe('Tangram');
  });

  it('runs the CLI only from apps/app', () => {
    for (const [name, command] of Object.entries(scriptsOf(WORKSPACE))) {
      const { hit, residue } = invokesCapAtRoot(command);
      if (hit) {
        expect.fail(
          `root script "${name}" invokes the Capacitor CLI with the workspace root as cwd ` +
            `(after stripping delegation: "${residue}"). Route it through \`pnpm -F app\`.`,
        );
      }
    }

    const capScripts = Object.entries(scriptsOf(APP)).filter(([, command]) => INVOKES_CAP.test(command));
    expect(capScripts.length).toBeGreaterThan(0);
  });

  it('the root-script guard passes a delegating command and fails a bare one', () => {
    // The guard above is only as good as its predicate, and the predicate is the
    // part that was wrong the first time — it banned the token `cap`, which
    // rejects `pnpm -F app cap sync android`, the line android.md A1 adds. Both
    // cases are pinned here against the same function the guard uses.
    const atRoot = (command: string) => invokesCapAtRoot(command).hit;

    for (const ok of [
      'pnpm -F app cap sync android',
      'pnpm --filter app cap sync ios',
      'pnpm run -F app cap add android',
      'pnpm -F app cap:sync:ios',
      'pnpm build && pnpm -F app cap sync android',
      'cd apps/app && cap sync ios',
      'vite build',
    ]) {
      expect(atRoot(ok), ok).toBe(false);
    }

    for (const bad of ['cap sync ios', 'npx cap sync ios', 'pnpm build && cap sync ios', 'pnpm -F server build; cap copy']) {
      expect(atRoot(bad), bad).toBe(true);
    }
  });
});
