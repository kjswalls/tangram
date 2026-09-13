/**
 * Logging, with the one rule that matters for a service holding somebody's
 * model key: **a secret never reaches stdout.**
 *
 * This is not hypothetical hygiene. The three things that leak a key in a small
 * proxy are, in order of how often they actually happen: an unhandled error
 * whose `cause` is the provider SDK's request object (which carries the
 * `Authorization` header), a "request failed, here is what we sent" debug line,
 * and a boot-time dump of `process.env`. `redact()` covers the first two and
 * nothing in this package does the third — `config.ts` reads named variables
 * and never enumerates.
 *
 * The redactor is deliberately *value*-based rather than key-based. A key-based
 * scrubber ("drop anything called apiKey") only works on objects whose shape you
 * predicted; a value-based one catches the key wherever it ended up, including
 * inside a message string a third-party SDK formatted. Both are applied here:
 * known header names are dropped by name, and the live secret values are
 * replaced wherever they appear.
 */
import { SECRET_HEADER_NAMES, secretValues, type Env } from './config.ts';

export const REDACTION = '[redacted]';

/** Provider-key shapes, redacted even when the value is not in this process's env. */
const KEY_SHAPED = [
  // Anthropic keys. The suffix class is deliberately broad: what matters is
  // that the whole token goes, not that the pattern is exact.
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9]{16,}/g,
  // `Authorization: Bearer <token>` as it appears inside a formatted message.
  /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}/g,
];

/**
 * Replace every secret in a string.
 *
 * Exported separately from `redact` because an error message is a string and
 * the recursion below has to bottom out somewhere testable.
 */
export function redactString(input: string, env: Env = process.env): string {
  let out = input;
  for (const value of secretValues(env)) {
    // `split`/`join` rather than a RegExp: a secret may contain regex
    // metacharacters, and building a pattern out of it is how a redactor
    // throws on the one input it exists for.
    out = out.split(value).join(REDACTION);
  }
  for (const pattern of KEY_SHAPED) out = out.replace(pattern, REDACTION);
  return out;
}

/** Is this header name one whose value is a credential? */
export function isSecretHeader(name: string): boolean {
  return (SECRET_HEADER_NAMES as readonly string[]).includes(name.toLowerCase());
}

/**
 * Redact a value of any shape, recursively, for logging.
 *
 * Cycles are tolerated (an SDK error's `cause` chain can be cyclic) and depth
 * is bounded, because a redactor that hangs or blows the stack on a weird error
 * object means the error is never logged at all.
 */
export function redact(value: unknown, env: Env = process.env, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value, env);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message, env),
      ...(value.stack ? { stack: redactString(value.stack, env) } : {}),
      ...(value.cause === undefined ? {} : { cause: redact(value.cause, env, depth + 1, seen) }),
    };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, env, depth + 1, seen));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretHeader(key) ? REDACTION : redact(item, env, depth + 1, seen);
  }
  return out;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export type LogSink = (line: string) => void;

/**
 * One JSON object per line. Structured because the first thing anyone does with
 * a proxy's logs is grep them for one request id, and unstructured prose does
 * not survive that.
 */
export function createLogger(sink: LogSink = (line) => console.log(line), env: Env = process.env): Logger {
  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    const record = {
      level,
      time: new Date().toISOString(),
      message: redactString(message, env),
      ...(fields ? (redact(fields, env) as Record<string, unknown>) : {}),
    };
    sink(JSON.stringify(record));
  };
  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
