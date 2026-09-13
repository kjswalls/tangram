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
 * Three things here are not defensive programming; each is a leak that was
 * demonstrated against the first version of this file.
 *
 *  1. **Function-valued properties are dropped.** A function is not an object,
 *     so an earlier version returned it unchanged — and `createLogger` then
 *     called `JSON.stringify`, which invokes any surviving own `toJSON` and
 *     re-materialises the object AFTER redaction ran. An own `toJSON` is exactly
 *     how a hand-rolled request wrapper gets logged, and the key came out in
 *     cleartext.
 *  2. **Binary is summarised, never walked.** `Object.entries` on a `Buffer` or
 *     a typed array yields its numeric indices, so the walk emitted every byte
 *     as a number and `Buffer.from(Object.values(x))` recovered the secret
 *     exactly. Length only.
 *  3. **`Map`, `Set`, `Headers` and `URLSearchParams` are converted to entries
 *     rather than falling through the plain-object walk**, which rendered them
 *     as `{}` — silently lossy, and it made `isSecretHeader` dead for a real
 *     `Headers` object, which is the one container a proxy logs most.
 *
 * Cycles are tolerated and depth is bounded, because a redactor that hangs or
 * blows the stack on a weird error object means the error is never logged at
 * all. The cycle guard tracks the **current path**, not every object ever seen:
 * a shared sibling reference is a DAG, not a cycle, and reporting it as
 * `[circular]` replaces the field the operator was reading the log for.
 * A property whose getter throws yields `'[getter threw]'` rather than
 * propagating, for the same reason.
 */
export function redact(value: unknown, env: Env = process.env, depth = 0, path = new Set<object>()): unknown {
  if (typeof value === 'string') return redactString(value, env);
  // See 1. Dropped rather than kept: nothing downstream may call it.
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return '[symbol]';
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[depth]';
  if (path.has(value)) return '[circular]';

  // See 2. Before anything that could enumerate indices.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[binary ${value.byteLength} bytes]`;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return redactString(String(value), env);
  if (value instanceof URL) return redactString(value.href, env);

  path.add(value);
  try {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactString(value.message, env),
        ...(value.stack ? { stack: redactString(value.stack, env) } : {}),
        // An SDK hangs its request and response off the error; those are where
        // the credential lives, so they are walked rather than skipped.
        ...redactOwnProperties(value, env, depth, path, ERROR_OWN_SKIP),
        ...(readProperty(value, 'cause') === undefined
          ? {}
          : { cause: redact(readProperty(value, 'cause'), env, depth + 1, path) }),
      };
    }
    if (Array.isArray(value)) return value.map((item) => redact(item, env, depth + 1, path));

    // See 3. `Headers` and `URLSearchParams` expose `.entries()`; so do Map and
    // Set. Converting them keeps `isSecretHeader` alive and keeps the data.
    const entries = keyedEntries(value);
    if (entries) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of entries) {
        out[key] = isSecretHeader(key) ? REDACTION : redact(item, env, depth + 1, path);
      }
      return out;
    }
    if (value instanceof Set) return [...value].map((item) => redact(item, env, depth + 1, path));

    return redactOwnProperties(value, env, depth, path, EMPTY_SKIP);
  } finally {
    // The guard is the path, not the history — a sibling seen twice is a DAG.
    path.delete(value);
  }
}

const ERROR_OWN_SKIP = new Set(['name', 'message', 'stack', 'cause']);
const EMPTY_SKIP: ReadonlySet<string> = new Set();

/** `Map`/`Headers`/`URLSearchParams` as `[key, value]` pairs, or null. */
function keyedEntries(value: object): [string, unknown][] | null {
  if (value instanceof Map) return [...value].map(([key, item]) => [String(key), item]);
  if (typeof Headers !== 'undefined' && value instanceof Headers) return [...value.entries()];
  if (value instanceof URLSearchParams) return [...value.entries()];
  return null;
}

/** Read one property without letting a throwing getter escape. */
function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return '[getter threw]';
  }
}

function redactOwnProperties(
  value: object,
  env: Env,
  depth: number,
  path: Set<object>,
  skip: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (skip.has(key)) continue;
    if (isSecretHeader(key)) {
      out[key] = REDACTION;
      continue;
    }
    out[key] = redact(readProperty(value, key), env, depth + 1, path);
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
