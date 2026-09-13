/**
 * The server's environment, read once and never logged.
 *
 * Two rules shape this module and both are about the one asset this service
 * exists to hold (docs/STACK.md §2.8: the learner's model key never touches a
 * browser, so it lives here instead).
 *
 *  1. **A secret is read through a named accessor and nowhere else.** There is
 *     no `config` object carrying `anthropicApiKey` around, because an object
 *     that carries it is an object something will eventually `JSON.stringify`
 *     into a log line or an error body.
 *  2. **`SECRET_ENV_NAMES` is the list the redactor reads**, so adding a secret
 *     to this file is what teaches `log.ts` to scrub it. A secret added to the
 *     environment and not to this list is invisible to the redactor, which is
 *     why `tests/config.test.ts` asserts the list against `.env.example`'s
 *     secret-shaped names rather than trusting anyone to remember.
 */

export type Env = Record<string, string | undefined>;

/**
 * Every environment variable whose *value* must never reach a log, a response
 * body or an error message. Names, not values — the names are not secret and
 * being able to say "TANGRAM_ACCESS_SECRET is unset" is diagnostically useful.
 */
export const SECRET_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'TANGRAM_ACCESS_SECRET',
] as const;

/** Request headers that carry a credential and must be dropped before logging. */
export const SECRET_HEADER_NAMES = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-tangram-access',
  'proxy-authorization',
] as const;

export const DEFAULT_PORT = 8787;

export interface ServerConfig {
  /** The interface to bind. `0.0.0.0` in a container, `127.0.0.1` by default. */
  host: string;
  port: number;
  /** `production` disables the stack trace in a 500 body. */
  production: boolean;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Read the listen configuration.
 *
 * `PORT` is what every host in the running for B0 sets, and an unparseable one
 * is a hard failure rather than a silent fall back to 8787: a service listening
 * on the wrong port looks healthy locally and is unreachable in the deployment,
 * which is the failure shape this plan's W0 predecessor spent a review on.
 */
export function readConfig(env: Env = process.env): ServerConfig {
  const rawPort = env.PORT?.trim();
  let port = DEFAULT_PORT;
  if (rawPort !== undefined && rawPort !== '') {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      throw new ConfigError(`PORT must be an integer between 0 and 65535, got ${JSON.stringify(rawPort)}`);
    }
    port = parsed;
  }
  const host = env.HOST?.trim() || '0.0.0.0';
  return { host, port, production: env.NODE_ENV === 'production' };
}

/**
 * The values the redactor must scrub, in the current environment.
 *
 * Whitespace-only counts as unset, the same reading `lib/server/access.ts`
 * already takes of `TANGRAM_ACCESS_SECRET`, and very short values are skipped:
 * scrubbing every occurrence of a one-character "secret" would redact the whole
 * log and teach everyone to turn the redactor off.
 */
export const MIN_REDACTABLE_LENGTH = 8;

export function secretValues(env: Env = process.env): string[] {
  const out: string[] = [];
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value && value.length >= MIN_REDACTABLE_LENGTH) out.push(value);
  }
  return out;
}
