/**
 * Write `dist/build-info.json` after `tsc` has emitted.
 *
 * `src/build-info.ts` reads it and `/health` returns it, so this is what makes
 * "a redeploy changes the sha" true (docs/plans/backend.md B0).
 *
 * It never fails the build. A tree with no `.git` — a host that builds from an
 * archive — falls back to `TANGRAM_BUILD_SHA` and then to `'unknown'`, which is
 * the same ladder `readBuildInfo` walks at runtime. A build that refused to
 * finish because it could not name itself would be a worse outcome than a
 * health route that says `unknown`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', 'dist');

function gitSha(): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: here,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

const sha = gitSha() ?? process.env.TANGRAM_BUILD_SHA?.trim() ?? 'unknown';
mkdirSync(distDir, { recursive: true });
writeFileSync(
  resolve(distDir, 'build-info.json'),
  `${JSON.stringify({ sha, builtAt: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
);
console.log(`stamped dist/build-info.json with ${sha}`);
