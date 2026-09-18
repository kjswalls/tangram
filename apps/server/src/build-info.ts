/**
 * What build is this?
 *
 * docs/plans/backend.md B0: `/health` returns the git sha of the deploy and a
 * redeploy changes it. The point is not the route — it is that there is a way
 * to tell, from outside, which code is answering. A rollback that cannot be
 * observed is not a rollback.
 *
 * Resolution order, and the order is the argument:
 *
 *  1. **`dist/build-info.json`**, written by `scripts/stamp.ts` during
 *     `pnpm -F server build`. It is derived from the tree that produced the
 *     JavaScript being executed, so it is the only source that cannot disagree
 *     with the running code. **A stamp whose sha is `'unknown'` does not count**
 *     — it is the stamp saying it had nothing to record, and treating it as an
 *     answer would permanently shadow step 2 on exactly the host step 2 exists
 *     for: one that builds from an archive with no `.git` and injects the commit
 *     as a runtime variable.
 *  2. **`TANGRAM_BUILD_SHA`** from the environment, for a host that builds from
 *     an archive with no `.git` and injects its own commit variable.
 *  3. `'unknown'`. Never a throw and never a crash at boot: a service that will
 *     not start because it cannot name itself is worse than one that says so.
 */
import { readFileSync } from 'node:fs';

import type { Env } from './config.ts';

export interface BuildInfo {
  /** The full 40-character sha, or `'unknown'`. */
  sha: string;
  /** ISO 8601, or null when the stamp is absent. */
  builtAt: string | null;
  /** Which of the three sources above answered. Diagnostic. */
  source: 'stamp' | 'env' | 'unknown';
}

export const UNKNOWN_SHA = 'unknown';

/** Where the stamp sits next to the emitted `build-info.js`. */
export const STAMP_FILE = 'build-info.json';

/**
 * What an environment-supplied sha must look like before `/health` publishes it.
 *
 * `/health` is public, uncached and unauthenticated, so the one value it echoes
 * from the environment is the one value that has to be checked: a mis-templated
 * host variable (`${GIT_SHA}` unexpanded, a branch name, a whole URL) would
 * otherwise be published verbatim. The stamp is not checked against this — it is
 * written by this package's own build, which already validates it, and a
 * `-dirty` suffix is deliberate information.
 */
const SHA_SHAPE = /^[0-9a-f]{7,40}$/i;

function readStamp(stampUrl: URL): { sha?: unknown; builtAt?: unknown } | null {
  try {
    return JSON.parse(readFileSync(stampUrl, 'utf8')) as { sha?: unknown; builtAt?: unknown };
  } catch {
    // Absent under `tsx src/index.ts`, and absent is a legal state — see 2 and 3.
    return null;
  }
}

export function readBuildInfo(
  env: Env = process.env,
  stampUrl: URL = new URL(STAMP_FILE, import.meta.url),
): BuildInfo {
  const stamp = readStamp(stampUrl);
  const stamped = typeof stamp?.sha === 'string' ? stamp.sha.trim() : '';
  if (stamp && stamped.length > 0 && stamped !== UNKNOWN_SHA) {
    return {
      sha: stamped,
      builtAt: typeof stamp.builtAt === 'string' ? stamp.builtAt : null,
      source: 'stamp',
    };
  }
  const fromEnv = env.TANGRAM_BUILD_SHA?.trim();
  if (fromEnv && SHA_SHAPE.test(fromEnv)) return { sha: fromEnv, builtAt: null, source: 'env' };
  return { sha: UNKNOWN_SHA, builtAt: null, source: 'unknown' };
}
