/**
 * The API smoke CLI. It is unit-tested against a fake `fetch` and against the
 * real app's `fetch`, because the thing it must not do is pass against a server
 * that is not answering.
 */
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { ROUTES } from '../src/routes/table.ts';
import {
  ACCESS_HEADER,
  expectedStatus,
  formatResults,
  parseArgs,
  runSmoke,
  UsageError,
} from '../src/smoke.ts';

describe('parseArgs', () => {
  it('requires a base url', () => {
    expect(() => parseArgs([])).toThrow(UsageError);
  });

  it('reads the base url, the key and the timeout, and trims a trailing slash', () => {
    const options = parseArgs(['--base-url', 'https://api.example.test/', '--key', 'sekrit', '--timeout-ms', '250']);
    expect(options).toEqual({ baseUrl: 'https://api.example.test', key: 'sekrit', timeoutMs: 250 });
  });

  it('rejects an unknown argument rather than ignoring it', () => {
    expect(() => parseArgs(['--base-url', 'http://x', '--danger'])).toThrow(UsageError);
  });
});

describe('expectedStatus', () => {
  const gated = { path: '/api/ask', methods: ['POST'] as const, gated: true, smoke: [] };

  it('expects 401 from a gated route when no key was supplied', () => {
    expect(expectedStatus({ ...gated, methods: ['POST'] }, { method: 'POST', expect: 200 }, false)).toBe(401);
  });

  it('expects the route’s own status once a key is supplied', () => {
    expect(expectedStatus({ ...gated, methods: ['POST'] }, { method: 'POST', expect: 200 }, true)).toBe(200);
  });
});

describe('runSmoke', () => {
  it('passes against the real app', async () => {
    const app = buildApp();
    const results = await runSmoke(
      { baseUrl: 'http://smoke.test', timeoutMs: 5_000 },
      async (input, init) => app.request(String(input), init as RequestInit),
    );
    expect(results).toHaveLength(ROUTES.reduce((n, r) => n + r.smoke.length, 0));
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('fails when a route answers the wrong status — the whole point of it', async () => {
    const results = await runSmoke({ baseUrl: 'http://smoke.test', timeoutMs: 5_000 }, async () =>
      new Response('nope', { status: 503 }),
    );
    expect(results.every((r) => r.ok)).toBe(false);
    expect(formatResults(results)).toContain('FAIL');
  });

  it('fails, rather than passing, when nothing is listening', async () => {
    const results = await runSmoke({ baseUrl: 'http://smoke.test', timeoutMs: 5_000 }, async () => {
      throw new Error('connect ECONNREFUSED');
    });
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(formatResults(results)).toContain('no response');
  });

  it('sends the key as X-Tangram-Access and never puts it in a result line', async () => {
    const key = 'a-very-secret-value';
    const seen: Headers[] = [];
    const results = await runSmoke({ baseUrl: 'http://smoke.test', key, timeoutMs: 5_000 }, async (_input, init) => {
      seen.push(new Headers(init?.headers));
      throw new Error(`request with key ${key} failed`);
    });
    expect(seen[0]?.get(ACCESS_HEADER)).toBe(key);
    expect(formatResults(results)).not.toContain(key);
    expect(formatResults(results)).toContain('[redacted]');
  });
});
