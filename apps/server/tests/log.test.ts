/**
 * The key-custody lens, as tests.
 *
 * docs/STACK.md §2.8 makes this server the only place a model key ever exists.
 * The three ways a small proxy leaks one are an error whose `cause` carries the
 * `Authorization` header, a debug line that prints the outgoing request, and a
 * boot-time dump of the environment. The first two are what `redact` is for;
 * the third is asserted in `config.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { MIN_REDACTABLE_LENGTH, SECRET_ENV_NAMES, secretValues } from '../src/config.ts';
import { createLogger, isSecretHeader, REDACTION, redact, redactString } from '../src/log.ts';

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-REALKEYMATERIAL-000',
  TANGRAM_ACCESS_SECRET: 'access-secret-value',
};

describe('redactString', () => {
  it('replaces a configured secret wherever it appears', () => {
    expect(redactString(`key=${env.ANTHROPIC_API_KEY} ok`, env)).toBe(`key=${REDACTION} ok`);
  });

  it('replaces a key-shaped token that is NOT in this environment', () => {
    // The key on a request being proxied for another account is not in
    // process.env, which is exactly the case B6 creates.
    expect(redactString('Authorization: sk-ant-api03-SOMEONEELSES-123', {})).toContain(REDACTION);
    expect(redactString('Authorization: sk-ant-api03-SOMEONEELSES-123', {})).not.toContain('SOMEONEELSES');
  });

  it('redacts a bearer token', () => {
    expect(redactString('sent Bearer eyJhbGciOiJIUzI1NiJ9.abc', {})).toContain(REDACTION);
  });

  it('does not throw on a secret containing regex metacharacters', () => {
    const weird = { TANGRAM_ACCESS_SECRET: 'a+b*c(d)[e]$f' };
    expect(redactString('value a+b*c(d)[e]$f here', weird)).toBe(`value ${REDACTION} here`);
  });

  it('ignores a secret too short to redact safely', () => {
    expect(secretValues({ TANGRAM_ACCESS_SECRET: 'ab' })).toEqual([]);
    expect(MIN_REDACTABLE_LENGTH).toBeGreaterThan(1);
  });

  it('treats whitespace-only as unset, the same reading lib/server/access.ts takes', () => {
    expect(secretValues({ TANGRAM_ACCESS_SECRET: '   ' })).toEqual([]);
  });
});

describe('redact', () => {
  it('drops credential headers by name', () => {
    const out = redact({ headers: { authorization: 'Basic abc', 'x-tangram-access': 'whatever', accept: 'json' } }, {}) as {
      headers: Record<string, string>;
    };
    expect(out.headers.authorization).toBe(REDACTION);
    expect(out.headers['x-tangram-access']).toBe(REDACTION);
    expect(out.headers.accept).toBe('json');
  });

  it('walks an error cause chain, which is where an SDK puts the request', () => {
    const cause = new Error(`POST https://api.anthropic.com failed with ${env.ANTHROPIC_API_KEY}`);
    const error = new Error('provider failed', { cause });
    expect(JSON.stringify(redact(error, env))).not.toContain('REALKEYMATERIAL');
  });

  it('survives a cyclic object instead of hanging', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(JSON.stringify(redact(a, {}))).toContain('[circular]');
  });

  it('bounds depth instead of blowing the stack', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    expect(JSON.stringify(redact(deep, {}))).toContain('[depth]');
  });

  it('knows which header names carry a credential', () => {
    expect(isSecretHeader('Authorization')).toBe(true);
    expect(isSecretHeader('X-Tangram-Access')).toBe(true);
    expect(isSecretHeader('Cookie')).toBe(true);
    expect(isSecretHeader('content-type')).toBe(false);
  });
});

describe('createLogger', () => {
  it('writes one JSON object per line', () => {
    const lines: string[] = [];
    createLogger((line) => lines.push(line), {}).info('listening', { port: 8787 });
    expect(JSON.parse(lines[0] as string)).toMatchObject({ level: 'info', message: 'listening', port: 8787 });
  });

  it('redacts both the message and the fields', () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line), env);
    logger.error(`failed with ${env.TANGRAM_ACCESS_SECRET}`, {
      error: new Error(env.ANTHROPIC_API_KEY),
      headers: { authorization: 'Bearer abc' },
    });
    const line = lines[0] as string;
    expect(line).not.toContain('access-secret-value');
    expect(line).not.toContain('REALKEYMATERIAL');
    expect(line).not.toContain('Bearer abc');
  });
});

describe('SECRET_ENV_NAMES', () => {
  it('names every secret this package reads, because the redactor reads this list', () => {
    expect([...SECRET_ENV_NAMES]).toEqual(['ANTHROPIC_API_KEY', 'TANGRAM_ACCESS_SECRET']);
  });
});
