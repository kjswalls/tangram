/**
 * The API smoke CLI. Tested against a fake `fetch` and against the real app's
 * `fetch`, because the thing it must not do is pass against a server that is not
 * answering — and, once B1 lands the gated routes, against a server whose gate
 * has quietly stopped existing.
 */
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { ROUTES, type ServerRoute } from '../src/routes/table.ts';
import {
  ACCESS_HEADER,
  describeFailure,
  formatResults,
  parseArgs,
  probesFor,
  runSmoke,
  UsageError,
} from '../src/smoke.ts';

const GATED: ServerRoute = {
  path: '/api/ask/answer',
  methods: ['POST'],
  gated: true,
  smoke: [{ method: 'POST', body: {}, expect: 200 }],
};

describe('parseArgs', () => {
  it('requires a base url', () => {
    expect(() => parseArgs([], {}, () => {})).toThrow(UsageError);
  });

  it('takes the key from the environment, which is where the server already reads it', () => {
    const options = parseArgs(['--base-url', 'https://api.example.test/'], {
      TANGRAM_ACCESS_SECRET: 'from-the-environment',
    }, () => {});
    expect(options).toEqual({
      baseUrl: 'https://api.example.test',
      key: 'from-the-environment',
      timeoutMs: 15_000,
      gate: 'off',
    });
  });

  it('accepts --key, because backend.md B1 names it, but warns that it leaks', () => {
    // pnpm echoes the resolved script command on start and again in its failure
    // banner, so `pnpm -F server smoke --key hunter2` prints hunter2 twice; the
    // value is also in ps output and shell history. Verified by running it.
    const warnings: string[] = [];
    const options = parseArgs(['--base-url', 'http://x', '--key', 'sekrit'], {}, (m) => warnings.push(m));
    expect(options.key).toBe('sekrit');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/TANGRAM_ACCESS_SECRET/);
  });

  it('rejects an unknown argument rather than ignoring it', () => {
    expect(() => parseArgs(['--base-url', 'http://x', '--danger'], {}, () => {})).toThrow(UsageError);
  });

  it('rejects --gate on with no secret to send', () => {
    expect(() => parseArgs(['--base-url', 'http://x', '--gate', 'on'], {}, () => {})).toThrow(UsageError);
    expect(() => parseArgs(['--base-url', 'http://x', '--gate', 'sometimes'], {}, () => {})).toThrow(UsageError);
  });
});

describe('probesFor', () => {
  it('turns one gated case into a refusal AND an answer when the gate is on', () => {
    // Checking only the keyed request would not notice a gate that had stopped
    // existing; checking only the unkeyed one would not notice a broken route.
    const probes = probesFor(GATED, GATED.smoke[0]!, 'on');
    expect(probes.map((p) => [p.withKey, p.expect])).toEqual([
      [false, 401],
      [true, 200],
    ]);
  });

  it('expects a gated route to answer normally when the gate is off', () => {
    // access.ts rule 1: an unset TANGRAM_ACCESS_SECRET means there is no gate,
    // so a healthy local server answers 200 and the smoke must not fail it.
    expect(probesFor(GATED, GATED.smoke[0]!, 'off')).toEqual([
      { path: '/api/ask/answer', method: 'POST', body: {}, withKey: false, expect: 200 },
    ]);
  });

  it('leaves an ungated route as one probe either way', () => {
    const health = ROUTES.find((r) => r.path === '/health')!;
    expect(probesFor(health, health.smoke[0]!, 'on')).toHaveLength(1);
    expect(probesFor(health, health.smoke[0]!, 'off')).toHaveLength(1);
  });
});

describe('describeFailure', () => {
  it('walks the cause chain, because Node’s fetch always says only "fetch failed"', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), { code: 'ECONNREFUSED' });
    expect(describeFailure(new Error('fetch failed', { cause }))).toContain('ECONNREFUSED');
  });

  it('says a timeout timed out', () => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    expect(describeFailure(error)).toContain('timed out');
  });
});

describe('runSmoke', () => {
  it('passes against the real app', async () => {
    const app = buildApp();
    const results = await runSmoke(
      { baseUrl: 'http://smoke.test', timeoutMs: 5_000, gate: 'off' },
      async (input, init) => app.request(String(input), init as RequestInit),
    );
    expect(results).toHaveLength(ROUTES.reduce((n, r) => n + r.smoke.length, 0));
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('fails when a route answers the wrong status — the whole point of it', async () => {
    const results = await runSmoke({ baseUrl: 'http://smoke.test', timeoutMs: 5_000, gate: 'off' }, async () =>
      new Response('nope', { status: 503 }),
    );
    expect(results.every((r) => r.ok)).toBe(false);
    expect(formatResults(results)).toContain('FAIL');
  });

  it('fails, rather than passing, when nothing is listening', async () => {
    const results = await runSmoke({ baseUrl: 'http://smoke.test', timeoutMs: 5_000, gate: 'off' }, async () => {
      throw new Error('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    });
    expect(results.every((r) => !r.ok)).toBe(true);
    const text = formatResults(results);
    expect(text).toContain('no response');
    expect(text).toContain('ECONNREFUSED');
  });

  it('sends the key as X-Tangram-Access and never puts it in a result line', async () => {
    const key = 'a-very-secret-value';
    const seen: Headers[] = [];
    const results = await runSmoke(
      { baseUrl: 'http://smoke.test', key, timeoutMs: 5_000, gate: 'on' },
      async (_input, init) => {
        seen.push(new Headers(init?.headers));
        throw new Error(`request with key ${key} failed`);
      },
    );
    expect(seen[0]?.get(ACCESS_HEADER)).toBe(key);
    expect(formatResults(results)).not.toContain(key);
    expect(formatResults(results)).toContain('[redacted]');
  });
});
