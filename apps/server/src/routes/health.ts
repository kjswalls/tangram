/**
 * `GET /health` — which build is answering, and for how long it has been up.
 *
 * docs/plans/backend.md B0: "the point is that a deploy procedure exists and is
 * repeatable, not that the route is interesting."
 *
 * **It publishes exactly one environment-derived value and no others**: the sha,
 * which falls back to `TANGRAM_BUILD_SHA` when there is no build stamp. That one
 * is safe because `readBuildInfo` refuses anything that is not sha-shaped, so a
 * mis-templated host variable becomes `'unknown'` rather than being echoed to
 * the internet. Nothing else about the configuration is returned, no count of
 * anything, and no upstream check: a health route that reports its configuration
 * is a health route that will one day report a secret, and a health route that
 * pings the provider is a health route that spends money every time a load
 * balancer polls it.
 */
import { readBuildInfo, type BuildInfo } from '../build-info.ts';

export interface HealthBody {
  status: 'ok';
  /** The git sha of this build, or `'unknown'`. */
  sha: string;
  /** Where the sha came from. */
  shaSource: BuildInfo['source'];
  builtAt: string | null;
  /** Milliseconds since this process started. A restart is visible here. */
  uptimeMs: number;
}

export function healthBody(startedAt: number, now: number = Date.now()): HealthBody {
  const build = readBuildInfo();
  return {
    status: 'ok',
    sha: build.sha,
    shaSource: build.source,
    builtAt: build.builtAt,
    uptimeMs: Math.max(0, now - startedAt),
  };
}

export function health(startedAt: number): Response {
  return Response.json(healthBody(startedAt), {
    // A cached health check is a health check that tells you about a process
    // that is no longer running.
    headers: { 'cache-control': 'no-store' },
  });
}
