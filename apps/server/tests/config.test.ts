/**
 * The environment, and the two rules that keep a secret out of everything else.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ConfigError, DEFAULT_PORT, isDevelopment, readConfig, SECRET_ENV_NAMES } from '../src/config.ts';

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(PACKAGE, 'src');
const WORKSPACE = resolve(PACKAGE, '..', '..');

describe('readConfig', () => {
  it('defaults to 0.0.0.0 and the documented port', () => {
    expect(readConfig({})).toEqual({ host: '0.0.0.0', port: DEFAULT_PORT, production: true });
  });

  it('prefers TANGRAM_SERVER_PORT over PORT, which the app already owns', () => {
    // PORT is apps/app's e2e/preview/smoke port (CLAUDE.md, playwright.config.ts,
    // scripts/preview.ts). A developer who exported it for the app must not move
    // this server on top of it — but a host that injects only PORT still works.
    expect(readConfig({ PORT: '3000' }).port).toBe(3000);
    expect(readConfig({ PORT: '3000', TANGRAM_SERVER_PORT: '8787' }).port).toBe(8787);
  });

  it('refuses an unparseable port rather than silently listening somewhere else', () => {
    expect(() => readConfig({ PORT: 'eighty' })).toThrow(ConfigError);
    expect(() => readConfig({ PORT: '70000' })).toThrow(ConfigError);
  });

  it('never puts a secret in the object it returns', () => {
    const config = readConfig({ ...Object.fromEntries(SECRET_ENV_NAMES.map((n) => [n, 'leak'])), PORT: '1' });
    expect(JSON.stringify(config)).not.toContain('leak');
  });
});

describe('production is the default, and development is opted into', () => {
  // The fail-open version of this — expose unless NODE_ENV === 'production' —
  // ships internal error text in public 500 bodies on every host that does not
  // set NODE_ENV, which is most of them. An error from `pg` or from the SDK
  // routinely carries a connection target, and from B6 this process holds
  // learners' provider keys.
  it('treats an environment with no NODE_ENV as production', () => {
    expect(readConfig({}).production).toBe(true);
    expect(isDevelopment({})).toBe(false);
  });

  it('treats a typo as production, not as development', () => {
    expect(isDevelopment({ NODE_ENV: 'prod' })).toBe(false);
    expect(isDevelopment({ NODE_ENV: 'Development' })).toBe(false);
  });

  it('opts in on NODE_ENV=development, NODE_ENV=test, or TANGRAM_EXPOSE_ERRORS=1', () => {
    expect(isDevelopment({ NODE_ENV: 'development' })).toBe(true);
    expect(isDevelopment({ NODE_ENV: 'test' })).toBe(true);
    expect(isDevelopment({ TANGRAM_EXPOSE_ERRORS: '1' })).toBe(true);
  });
});

describe('SECRET_ENV_NAMES covers every secret the deployment is told to set', () => {
  // config.ts's header promises this check by name. Without it the list is a
  // change detector that fires only when someone EDITS it — never when someone
  // adds a secret to the environment and forgets. B6 adds a key-encryption
  // secret and B3 an SMTP password; a secret the redactor cannot see reaches
  // stdout through the first error message that contains it.
  const SECRET_SHAPED = /(?:_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIAL)$/;

  it('is a superset of .env.example’s secret-shaped names', () => {
    const declared = readFileSync(resolve(WORKSPACE, '.env.example'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split('=')[0]?.trim() ?? '')
      .filter((name) => SECRET_SHAPED.test(name));

    expect(declared.length, '.env.example declares no secret-shaped name — did the file move?')
      .toBeGreaterThan(0);
    for (const name of declared) {
      expect(
        SECRET_ENV_NAMES as readonly string[],
        `${name} is in .env.example but not in SECRET_ENV_NAMES, so log.ts will never redact it`,
      ).toContain(name);
    }
  });
});

describe('the source itself', () => {
  /**
   * Every `.ts` under src/, walked rather than listed.
   *
   * A hardcoded list covers the files that already complied and none of the
   * files a later phase adds — so the rule stopped applying to exactly the
   * handlers B1 is about to write.
   */
  function sourceFiles(dir: string = SRC, prefix = ''): [string, string][] {
    const out: [string, string][] = [];
    for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${name.name}` : name.name;
      if (name.isDirectory()) out.push(...sourceFiles(join(dir, name.name), rel));
      else if (name.name.endsWith('.ts')) out.push([rel, readFileSync(join(dir, name.name), 'utf8')]);
    }
    return out;
  }

  /** Matches `process.env`, `process["env"]` and `process . env`. */
  const READS_ENV = /process\s*(?:\.\s*env\b|\[\s*['"`]env['"`]\s*\])/;

  /**
   * The modules allowed to read the environment: the entry point, and the three
   * that take an `Env` argument and default it. Everything else takes values.
   * `smoke.ts` is a CLI, not a handler.
   */
  const MAY_READ_ENV = new Set(['index.ts', 'config.ts', 'log.ts', 'build-info.ts', 'smoke.ts']);

  it('walks every file under src/, so a file added later is covered by default', () => {
    const files = sourceFiles().map(([file]) => file);
    expect(files).toContain('routes/health.ts');
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it('enumerates process.env nowhere — a dump is the third way a proxy leaks a key', () => {
    for (const [file, source] of sourceFiles()) {
      expect(source, file).not.toMatch(/Object\.(keys|values|entries)\(\s*process\s*\./);
      expect(source, file).not.toMatch(/\{\s*\.\.\.process\s*\./);
      expect(source, file).not.toMatch(/JSON\.stringify\(\s*process\s*\./);
    }
  });

  it('reads the environment only in the modules that take an Env argument', () => {
    // When B1 moves the three model routes here, this is the rule that stops one
    // of them reading the key directly instead of being handed it.
    for (const [file, source] of sourceFiles()) {
      if (MAY_READ_ENV.has(file)) continue;
      expect(source, `${file} reads the environment; handlers take values`).not.toMatch(READS_ENV);
    }
  });

  it('the allowlist names only files that exist', () => {
    const files = new Set(sourceFiles().map(([file]) => file));
    for (const allowed of MAY_READ_ENV) expect(files, `${allowed} is allowlisted but absent`).toContain(allowed);
  });
});
