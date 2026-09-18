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
 *     why `tests/config.test.ts` parses `.env.example` for every
 *     `*_KEY`/`*_SECRET`/`*_TOKEN`/`*_PASSWORD` name and requires each to be a
 *     member — a change detector that fires when someone *forgets*, rather than
 *     one that fires only when someone edits the list.
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
  /**
   * The interface to bind. Defaults to `0.0.0.0` — every candidate host runs
   * this in a container and expects it to accept from outside the loopback.
   * On a laptop that means every interface; set `HOST=127.0.0.1` for local work.
   */
  host: string;
  port: number;
  /**
   * True unless something explicitly says otherwise.
   *
   * **The default is the safe one, and that is the point.** It gates
   * `exposeErrors`, and the fail-open version of this — expose unless
   * `NODE_ENV === 'production'` — ships internal error text in public 500 bodies
   * on every host that does not set `NODE_ENV`, which is most of them. An error
   * message from `pg` or an SDK routinely carries a connection target, and from
   * B6 this process holds learners' provider keys. So: development is opted
   * into, production is what you get.
   */
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
  // TANGRAM_SERVER_PORT first, PORT second. PORT is NOT this server's private
  // name: apps/app/playwright.config.ts, scripts/preview.ts and scripts/smoke.ts
  // all read it for the app, and CLAUDE.md documents it as the e2e port. A host
  // that injects PORT still works; a developer who exported PORT for the app
  // does not accidentally move this server on top of it.
  const rawPort = (env.TANGRAM_SERVER_PORT ?? env.PORT)?.trim();
  let port = DEFAULT_PORT;
  if (rawPort !== undefined && rawPort !== '') {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      throw new ConfigError(
        `TANGRAM_SERVER_PORT/PORT must be an integer between 0 and 65535, got ${JSON.stringify(rawPort)}`,
      );
    }
    port = parsed;
  }
  const host = env.HOST?.trim() || '0.0.0.0';
  return { host, port, production: !isDevelopment(env) };
}

/**
 * Is this an environment that has explicitly asked for developer conveniences?
 *
 * Only two things say yes, and both have to be set deliberately. Everything
 * else — an unset `NODE_ENV`, a typo, a host that injects nothing — is
 * production.
 */
export function isDevelopment(env: Env = process.env): boolean {
  if (env.TANGRAM_EXPOSE_ERRORS?.trim() === '1') return true;
  const nodeEnv = env.NODE_ENV?.trim();
  return nodeEnv === 'development' || nodeEnv === 'test';
}

/**
 * The values the redactor must scrub, in the current environment.
 *
 * Whitespace-only counts as unset, the same reading `@tangram/access`
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
  // Longest first. If one secret contains another — an access secret that
  // happens to start with the API key, say — replacing the shorter one first
  // leaves the remainder of the longer one in the log: `[redacted]EXTRA`.
  return out.sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------
// What the three model routes read out of the environment
// ---------------------------------------------------------------------------

/**
 * The model name a live provider answers under, or `undefined` for the fake.
 *
 * It is read here rather than in the handlers because of the rule this file's
 * header states and `tests/config.test.ts` enforces: **a handler takes values;
 * it does not reach for `process`.** That rule was written in B0 with exactly
 * this phase named — "when B1 moves the three model routes here, this is the
 * rule that stops one of them reading the key directly instead of being handed
 * it" — and the three handlers each read `TANGRAM_MODEL` before the move.
 *
 * `DEFAULT_MODEL` is not duplicated: `packages/ai/anthropic.ts` owns it and the
 * caller passes it in, so a model changed in one place does not become two
 * answers depending on which module you read.
 */
export function modelName(fallback: string, env: Env = process.env): string {
  return env.TANGRAM_MODEL?.trim() || fallback;
}

/**
 * The four provider deadlines, by name.
 *
 * `docs/deploy.md` §3 and `.env.example` already define all four and
 * `backend.md` §3 lists them with their defaults; the values below are the ones
 * the handlers carried before the move, unchanged. They exist as environment
 * overrides for two reasons that both still hold: a test can prove a deadline
 * fires without waiting 30 s for it, and a deployment behind a slower upstream
 * — or behind a host whose function limit is under 30 s (`backend.md` §6, row
 * 2) — can move them with no rebuild.
 *
 * An unparseable or non-positive value falls back rather than throwing, which
 * is what the handlers did: a bad deadline must not take the route out, and the
 * failure it would cause (an ask that never returns) is worse than the value
 * being ignored.
 */
export const DEADLINE_DEFAULTS = {
  askPropose: { env: 'TANGRAM_ASK_PROPOSE_TIMEOUT_MS', ms: 8_000 },
  askAnswer: { env: 'TANGRAM_ASK_ANSWER_TIMEOUT_MS', ms: 30_000 },
  examples: { env: 'TANGRAM_EXAMPLES_TIMEOUT_MS', ms: 20_000 },
  recall: { env: 'TANGRAM_RECALL_TIMEOUT_MS', ms: 15_000 },
} as const satisfies Record<string, { env: string; ms: number }>;

export type DeadlineName = keyof typeof DEADLINE_DEFAULTS;

export function deadlineMs(name: DeadlineName, env: Env = process.env): number {
  const { env: variable, ms } = DEADLINE_DEFAULTS[name];
  const raw = Number(env[variable]);
  return Number.isFinite(raw) && raw > 0 ? raw : ms;
}
