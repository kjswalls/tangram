/**
 * The environment, and the rule that nothing enumerates it.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ConfigError, DEFAULT_PORT, readConfig, SECRET_ENV_NAMES } from '../src/config.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('readConfig', () => {
  it('defaults to 0.0.0.0 and the documented port', () => {
    expect(readConfig({})).toEqual({ host: '0.0.0.0', port: DEFAULT_PORT, production: false });
  });

  it('reads PORT, which is what every candidate host sets', () => {
    expect(readConfig({ PORT: '3000' }).port).toBe(3000);
  });

  it('refuses an unparseable PORT rather than silently listening somewhere else', () => {
    // A service on the wrong port looks healthy locally and is unreachable in
    // the deployment. Fail at boot, where it is visible.
    expect(() => readConfig({ PORT: 'eighty' })).toThrow(ConfigError);
    expect(() => readConfig({ PORT: '70000' })).toThrow(ConfigError);
  });

  it('never puts a secret in the object it returns', () => {
    const config = readConfig({ ...Object.fromEntries(SECRET_ENV_NAMES.map((n) => [n, 'leak'])), PORT: '1' });
    expect(JSON.stringify(config)).not.toContain('leak');
  });
});

describe('the source itself', () => {
  const sources = ['config.ts', 'log.ts', 'app.ts', 'index.ts', 'smoke.ts', 'build-info.ts', 'routes/health.ts', 'routes/table.ts'].map(
    (file) => [file, readFileSync(resolve(SRC, file), 'utf8')] as const,
  );

  it('enumerates process.env nowhere — a dump is the third way a proxy leaks a key', () => {
    for (const [file, source] of sources) {
      expect(source, file).not.toMatch(/Object\.(keys|values|entries)\(\s*process\.env/);
      expect(source, file).not.toMatch(/\{\s*\.\.\.process\.env/);
      expect(source, file).not.toMatch(/JSON\.stringify\(\s*process\.env/);
    }
  });

  it('reads process.env only in index.ts and the two modules that take an Env argument', () => {
    // Handlers take values; they do not reach for the environment. When B1
    // moves the three model routes here, this is the rule that stops one of
    // them reading the key directly.
    for (const [file, source] of sources) {
      if (['index.ts', 'config.ts', 'log.ts', 'build-info.ts', 'smoke.ts'].includes(file)) continue;
      expect(source, file).not.toContain('process.env');
    }
  });
});
