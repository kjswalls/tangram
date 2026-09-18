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

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: here,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * `HEAD`, with `-dirty` appended when the working tree is not clean.
 *
 * Without the suffix the 2 a.m. hotfix — edit on the box, rebuild, restart —
 * publishes the previous commit's sha through the most trustworthy-looking of
 * the three sources, for code that is not that commit. B0's rollback drill then
 * compares two shas, at least one of which does not identify what is running.
 */
function gitSha(): string | null {
  const sha = git(['rev-parse', 'HEAD']);
  if (sha === null || !/^[0-9a-f]{40}$/.test(sha)) return null;
  const status = git(['status', '--porcelain']);
  return status ? `${sha}-dirty` : sha;
}

/**
 * `'unknown'` is written as a real value, and `readBuildInfo` knows to ignore
 * it and fall through to `TANGRAM_BUILD_SHA`. Writing the file unconditionally
 * keeps `dist/` self-describing — a missing file and a file saying "nothing to
 * record" are different states and only one of them is a build that ran.
 */
const sha = gitSha() ?? process.env.TANGRAM_BUILD_SHA?.trim() ?? 'unknown';
mkdirSync(distDir, { recursive: true });
writeFileSync(
  resolve(distDir, 'build-info.json'),
  `${JSON.stringify({ sha, builtAt: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
);
console.log(`stamped dist/build-info.json with ${sha}`);
