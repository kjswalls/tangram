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
 * ## The gate, and how the key gets here
 *
 * With `TANGRAM_ACCESS_SECRET` set on the server, a gated route answers 401
 * without the `X-Tangram-Access` header and answers properly with it. Both are
 * worth asserting, so `--gate on` runs each gated case **twice** — once without
 * the header expecting 401, once with it expecting the route's own status —
 * which is B1's acceptance criterion exactly. `--gate off` asserts the open
 * behaviour. Whether a gate exists is a property of the server's environment,
 * not of the route, so it is stated rather than guessed: a smoke that accepted
 * either would not notice a gate that had stopped existing.
 *
 * **The key comes from the environment.** `TANGRAM_ACCESS_SECRET` is already the
 * name the server reads, so the variable is usually just there. `--key <value>`
 * still works because `backend.md` B1 names that spelling and `docs/deploy.md`
 * §7 documents the same shape for the app's smoke — but it **leaks**, and the
 * leak is in the recommended invocation rather than in this file: pnpm echoes
 * the resolved script command on start and again in its failure banner, so
 * `pnpm -F server smoke --key hunter2` prints `hunter2` to stdout twice, and the
 * value is in `ps` output and shell history for the whole run. Passing `--key`
 * therefore warns on stderr. Inside this module the key is never printed: it is
 * redacted out of every failure line and absent from the summary.
 */
import { pathToFileURL } from 'node:url';

import { ROUTES, type HttpMethod, type ServerRoute, type SmokeCase } from './routes/table.ts';

/** The header `web.md` W4 names and `backend.md` B1 must not rename. */
export const ACCESS_HEADER = 'x-tangram-access';

/** Whether the server under test has `TANGRAM_ACCESS_SECRET` set. */
export type GateMode = 'on' | 'off';

export interface SmokeOptions {
  baseUrl: string;
  key?: string;
  timeoutMs: number;
  gate: GateMode;
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

export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
  warn: (message: string) => void = (message) => console.error(message),
): SmokeOptions {
  let baseUrl: string | undefined;
  let key = env.TANGRAM_ACCESS_SECRET?.trim() || undefined;
  let timeoutMs = 15_000;
  let gate: GateMode = 'off';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--base-url') baseUrl = next();
    else if (arg === '--key') {
      key = next();
      // Not refused — B1 names this spelling — but never silent. The leak is
      // pnpm's command echo and the process list, neither of which this module
      // controls.
      warn(
        'smoke: --key puts the secret in pnpm\'s echoed command line, in ps output and in shell history. ' +
          'Prefer TANGRAM_ACCESS_SECRET in the environment.',
      );
    } else if (arg === '--gate') {
      const value = next();
      if (value !== 'on' && value !== 'off') throw new UsageError('--gate must be on or off');
      gate = value;
    } else if (arg === '--timeout-ms') {
      const parsed = Number(next());
      if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError('--timeout-ms must be a positive number');
      timeoutMs = parsed;
    } else if (arg === '--help' || arg === '-h') {
      throw new UsageError(
        'usage: smoke --base-url <url> [--gate on|off] [--timeout-ms <n>]\n' +
          '  the gate secret comes from TANGRAM_ACCESS_SECRET; --key <secret> works but leaks',
      );
    } else throw new UsageError(`unknown argument ${arg}`);
  }
  if (!baseUrl) throw new UsageError('--base-url is required');
  if (gate === 'on' && key === undefined) {
    throw new UsageError('--gate on needs the secret: set TANGRAM_ACCESS_SECRET (or pass --key)');
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), ...(key === undefined ? {} : { key }), timeoutMs, gate };
}

/**
 * The probes one smoke case turns into.
 *
 * With the gate off that is one request. With the gate on it is two, and the
 * pair is the assertion: a gated route must refuse without the header **and**
 * answer with it. Checking only the second would not notice a gate that had
 * stopped existing; checking only the first would not notice a broken route.
 */
export interface Probe {
  path: string;
  method: HttpMethod;
  body?: unknown;
  withKey: boolean;
  expect: number;
}

export function probesFor(route: ServerRoute, testCase: SmokeCase, gate: GateMode): Probe[] {
  const base = { path: route.path, method: testCase.method, ...(testCase.body === undefined ? {} : { body: testCase.body }) };
  if (!route.gated || gate === 'off') return [{ ...base, withKey: gate === 'on', expect: testCase.expect }];
  return [
    { ...base, withKey: false, expect: 401 },
    { ...base, withKey: true, expect: testCase.expect },
  ];
}

export function allProbes(gate: GateMode): Probe[] {
  return ROUTES.flatMap((route) => route.smoke.flatMap((testCase) => probesFor(route, testCase, gate)));
}

export async function runSmoke(
  options: SmokeOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<SmokeResult[]> {
  const results: SmokeResult[] = [];
  for (const probe of allProbes(options.gate)) {
    const headers: Record<string, string> = {};
    if (probe.body !== undefined) headers['content-type'] = 'application/json';
    if (probe.withKey && options.key !== undefined) headers[ACCESS_HEADER] = options.key;
    const init: RequestInit = {
      method: probe.method,
      headers,
      signal: AbortSignal.timeout(options.timeoutMs),
      ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) }),
    };
    const label = probe.withKey ? `${probe.method} (keyed)` : probe.method;
    try {
      const response = await fetchImpl(`${options.baseUrl}${probe.path}`, init);
      results.push({
        path: probe.path,
        method: label,
        expected: probe.expect,
        actual: response.status,
        ok: response.status === probe.expect,
      });
    } catch (error) {
      results.push({
        path: probe.path,
        method: label,
        expected: probe.expect,
        actual: null,
        ok: false,
        detail: scrub(describeFailure(error), options.key),
      });
    }
  }
  return results;
}

/**
 * Why the request failed, not merely that it did.
 *
 * Node's fetch sets `message` to the constant string "fetch failed" and puts the
 * real reason — `ECONNREFUSED`, `ENOTFOUND`, a TLS error — in `cause`. This tool
 * exists to be run when a deploy looks wrong, and one identical line for a
 * refused connection, an unresolvable hostname, a certificate mismatch and a
 * wrong port tells nobody anything.
 */
export function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.name === 'TimeoutError' ? 'timed out' : error.message];
  let cause: unknown = error.cause;
  for (let depth = 0; cause instanceof Error && depth < 4; depth += 1) {
    const code = (cause as NodeJS.ErrnoException).code;
    parts.push(code ? `${code}: ${cause.message}` : cause.message);
    cause = cause.cause;
  }
  return parts.join(' — ');
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
    const options = parseArgs(process.argv.slice(2), process.env);
    const results = await runSmoke(options);
    console.log(formatResults(results));
    process.exitCode = results.every((r) => r.ok) ? 0 : 1;
  } catch (error) {
    console.error(error instanceof UsageError ? error.message : String(error));
    process.exitCode = 2;
  }
}
