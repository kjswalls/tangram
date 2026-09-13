/**
 * `/health`, the route B0's acceptance criteria are written against, and the
 * 404/405 shapes around it.
 */
import { describe, expect, it } from 'vitest';

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
  it('falls back to TANGRAM_BUILD_SHA when the stamp file is absent', () => {
    const missing = new URL('./does-not-exist.json', import.meta.url);
    expect(readBuildInfo({ TANGRAM_BUILD_SHA: 'abc123' }, missing)).toEqual({
      sha: 'abc123',
      builtAt: null,
      source: 'env',
    });
  });

  it("falls back to 'unknown' rather than throwing when there is nothing to read", () => {
    const missing = new URL('./does-not-exist.json', import.meta.url);
    expect(readBuildInfo({}, missing)).toEqual({ sha: UNKNOWN_SHA, builtAt: null, source: 'unknown' });
  });
});
