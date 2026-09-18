/**
 * `/health`, the route B0's acceptance criteria are written against, and the
 * 404/405 shapes around it.
 */
import { rmSync, writeFileSync } from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { readBuildInfo, UNKNOWN_SHA } from '../src/build-info.ts';
import { healthBody } from '../src/routes/health.ts';

const app = buildApp({ startedAt: Date.now() - 1_234 });

describe('GET /health', () => {
  it('answers 200 with a sha and an uptime', async () => {
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(typeof body.sha).toBe('string');
    expect(body.uptimeMs).toBeGreaterThanOrEqual(1_000);
  });

  it('is never cached — a cached health check describes a process that may be gone', async () => {
    const response = await app.request('/health');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('reports no configuration at all', async () => {
    // The whole body, enumerated. A future phase that adds a field has to edit
    // this line, which is the moment to ask whether the field is a secret.
    const body = healthBody(Date.now());
    expect(Object.keys(body).sort()).toEqual(
      ['builtAt', 'sha', 'shaSource', 'status', 'uptimeMs'].sort(),
    );
  });

  it('does not leak an environment value even when one is set', async () => {
    process.env.TANGRAM_ACCESS_SECRET = 'smoke-test-secret-value';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-smoke-test-key-value';
    try {
      const text = await (await app.request('/health')).text();
      expect(text).not.toContain('smoke-test-secret-value');
      expect(text).not.toContain('sk-ant-smoke-test-key-value');
    } finally {
      delete process.env.TANGRAM_ACCESS_SECRET;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('refuses a verb the table did not declare, with 405 and an Allow header', async () => {
    const response = await app.request('/health', { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });

  it('404s an undeclared path', async () => {
    const response = await app.request('/api/dict/search?q=%E5%A5%BD');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not-found' });
  });
});

describe('the build stamp', () => {
  const missing = new URL('./does-not-exist.json', import.meta.url);

  it('falls back to TANGRAM_BUILD_SHA when the stamp file is absent', () => {
    expect(readBuildInfo({ TANGRAM_BUILD_SHA: 'abc1234' }, missing)).toEqual({
      sha: 'abc1234',
      builtAt: null,
      source: 'env',
    });
  });

  it("falls back to 'unknown' rather than throwing when there is nothing to read", () => {
    expect(readBuildInfo({}, missing)).toEqual({ sha: UNKNOWN_SHA, builtAt: null, source: 'unknown' });
  });

  it('does not let a stamp of "unknown" shadow TANGRAM_BUILD_SHA', () => {
    // The case .env.example's TANGRAM_BUILD_SHA comment describes: a host that
    // builds from an archive with no .git and injects the commit as a RUNTIME
    // variable. The build stamps 'unknown'; if that counted as an answer,
    // /health would report 'unknown' on every deploy and every rollback — and
    // B0's rollback drill compares exactly that value.
    const stamp = writeStamp({ sha: 'unknown', builtAt: '2026-09-13T00:00:00.000Z' });
    expect(readBuildInfo({ TANGRAM_BUILD_SHA: 'deadbeefcafe' }, stamp)).toEqual({
      sha: 'deadbeefcafe',
      builtAt: null,
      source: 'env',
    });
  });

  it('prefers a real stamp over the environment, because it describes the running code', () => {
    const stamp = writeStamp({ sha: 'feedface1234', builtAt: '2026-09-13T00:00:00.000Z' });
    expect(readBuildInfo({ TANGRAM_BUILD_SHA: 'deadbeefcafe' }, stamp).source).toBe('stamp');
  });

  it('keeps a -dirty suffix from the stamp, which is deliberate information', () => {
    const stamp = writeStamp({ sha: `${'a'.repeat(40)}-dirty`, builtAt: null });
    expect(readBuildInfo({}, stamp).sha).toMatch(/-dirty$/);
  });

  it('refuses an environment value that is not sha-shaped, rather than publishing it', () => {
    // /health is public, uncached and unauthenticated. A mis-templated host
    // variable would otherwise be echoed to the internet verbatim.
    for (const bad of ['${GIT_SHA}', 'refs/heads/main', 'https://example.test/build/7', 'abc']) {
      expect(readBuildInfo({ TANGRAM_BUILD_SHA: bad }, missing).sha, bad).toBe(UNKNOWN_SHA);
    }
  });

  it('survives a malformed stamp file instead of crashing at boot', () => {
    const broken = new URL('./broken-stamp.json', import.meta.url);
    writeFileSync(broken, '{ not json', 'utf8');
    try {
      expect(readBuildInfo({}, broken).source).toBe('unknown');
    } finally {
      rmSync(broken, { force: true });
    }
  });
});

let stampCounter = 0;
function writeStamp(body: { sha: string; builtAt: string | null }): URL {
  stampCounter += 1;
  const url = new URL(`./stamp-fixture-${stampCounter}.json`, import.meta.url);
  writeFileSync(url, JSON.stringify(body), 'utf8');
  fixtures.push(url);
  return url;
}

const fixtures: URL[] = [];
afterAll(() => {
  for (const url of fixtures) rmSync(url, { force: true });
});
