#!/usr/bin/env node
/**
 * `pnpm -F server smoke --base-url <url> [--key <secret>]`
 *
 * Hits every route this server declares and fails on any status the table did
 * not predict. docs/plans/backend.md B1 specifies it; B0 lands it because B0's
 * deliverable is a *repeatable* deploy and this is what makes one checkable.
 *
 * The workspace root's `pnpm smoke` (scripts/smoke.ts) is the other half and it
 * is `web.md` W2's — it walks the static app's pages. This one walks the API.
 * Neither knows about the other; both read a route table rather than a list
 * somebody maintains, because the failure this replaces is exactly "a route
 * shipped that no check exercised" (`lib/server/route-inventory.ts`'s header).
 *
 * The gate: with `TANGRAM_ACCESS_SECRET` set on the server, a gated route
 * answers 401 without the header. `--key` supplies `X-Tangram-Access` so the
 * smoke exercises the route rather than the refusal. **The key is sent and
 * never printed** — `--key` is read into a local, redacted out of every failure
 * line, and absent from the summary.
 */
import { pathToFileURL } from 'node:url';

import { ROUTES, type ServerRoute, type SmokeCase } from './routes/table.ts';

/** The header `web.md` W4 names and `backend.md` B1 must not rename. */
export const ACCESS_HEADER = 'x-tangram-access';

export interface SmokeOptions {
  baseUrl: string;
  key?: string;
  timeoutMs: number;
}

export interface SmokeResult {
  path: string;
  method: string;
  expected: number;
  actual: number | null;
  ok: boolean;
  detail?: string;
}

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export function parseArgs(argv: readonly string[]): SmokeOptions {
  let baseUrl: string | undefined;
  let key: string | undefined;
  let timeoutMs = 15_000;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--base-url') baseUrl = next();
    else if (arg === '--key') key = next();
    else if (arg === '--timeout-ms') {
      const parsed = Number(next());
      if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError('--timeout-ms must be a positive number');
      timeoutMs = parsed;
    } else if (arg === '--help' || arg === '-h') {
      throw new UsageError('usage: smoke --base-url <url> [--key <secret>] [--timeout-ms <n>]');
    } else throw new UsageError(`unknown argument ${arg}`);
  }
  if (!baseUrl) throw new UsageError('--base-url is required');
  return { baseUrl: baseUrl.replace(/\/+$/, ''), ...(key === undefined ? {} : { key }), timeoutMs };
}

/**
 * What status a case should produce against *this* server.
 *
 * A gated route with no key is a 401 whatever its own smoke case says, and
 * asserting that explicitly is the point: it is the one case where the healthy
 * answer is a refusal, and a smoke that accepted either would not notice a gate
 * that had stopped existing.
 */
export function expectedStatus(route: ServerRoute, testCase: SmokeCase, hasKey: boolean): number {
  if (route.gated && !hasKey) return 401;
  return testCase.expect;
}

export async function runSmoke(
  options: SmokeOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<SmokeResult[]> {
  const results: SmokeResult[] = [];
  for (const route of ROUTES) {
    for (const testCase of route.smoke) {
      const expected = expectedStatus(route, testCase, options.key !== undefined);
      const headers: Record<string, string> = {};
      if (testCase.body !== undefined) headers['content-type'] = 'application/json';
      if (options.key !== undefined) headers[ACCESS_HEADER] = options.key;
      const init: RequestInit = {
        method: testCase.method,
        headers,
        signal: AbortSignal.timeout(options.timeoutMs),
        ...(testCase.body === undefined ? {} : { body: JSON.stringify(testCase.body) }),
      };
      try {
        const response = await fetchImpl(`${options.baseUrl}${route.path}`, init);
        results.push({
          path: route.path,
          method: testCase.method,
          expected,
          actual: response.status,
          ok: response.status === expected,
        });
      } catch (error) {
        results.push({
          path: route.path,
          method: testCase.method,
          expected,
          actual: null,
          ok: false,
          // The secret can only be in this string if a fetch implementation put
          // it there; redact anyway. `redactString` needs the live env, and the
          // key was passed on the command line, so scrub it by value here.
          detail: scrub(error instanceof Error ? error.message : String(error), options.key),
        });
      }
    }
  }
  return results;
}

function scrub(text: string, key: string | undefined): string {
  return key && key.length >= 8 ? text.split(key).join('[redacted]') : text;
}

export function formatResults(results: readonly SmokeResult[]): string {
  const lines = results.map(
    (r) =>
      `${r.ok ? 'ok  ' : 'FAIL'} ${r.method} ${r.path} → ${r.actual ?? 'no response'} (expected ${r.expected})${r.detail ? ` — ${r.detail}` : ''}`,
  );
  const failed = results.filter((r) => !r.ok).length;
  lines.push(`${results.length - failed}/${results.length} routes ok`);
  return lines.join('\n');
}

/**
 * Run as a CLI, but importable by the tests above it. `process.argv[1]` is the
 * script the runtime was pointed at — the `.ts` file under `tsx`, the emitted
 * `.js` under `node dist/` — so comparing file URLs works in both.
 */
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const results = await runSmoke(options);
    console.log(formatResults(results));
    process.exitCode = results.every((r) => r.ok) ? 0 : 1;
  } catch (error) {
    console.error(error instanceof UsageError ? error.message : String(error));
    process.exitCode = 2;
  }
}
