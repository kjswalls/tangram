/**
 * `apps/app/vercel.json`, read and applied (docs/plans/web.md W2).
 *
 * **There is no host config file in this repository before this one, and until
 * it existed the header rules existed nowhere.** They lived in
 * `next.config.ts`'s `headers()` block, which `web.md` W1 deleted, and the
 * static host serves `dist/` with no server in front of it: a rule that is not
 * in this file is a rule that is not applied.
 *
 * Three consumers read the same file through this module, which is the whole
 * reason the module exists rather than each of them carrying its own copy of
 * the table:
 *
 *  1. `vite-plugins/headers.ts` applies it to the dev and preview servers, so a
 *     rule that is wrong is wrong locally too. That plugin used to hold a
 *     second, hand-written copy of two of the rules; `STATIC_HEADERS` is gone
 *     and this is what replaced it. **It applies headers only.** Applying
 *     rewrites locally was how W2's first version hid a defect rather than
 *     catching it — see the note on ordering below.
 *  2. `tests/unit/server/routes.test.ts` asserts every rule is present and that
 *     the artifact pattern matches the filename `pnpm data` actually produced.
 *  3. `scripts/smoke.ts` asserts the *served* response carries them, which
 *     against a real deployment is the only thing that proves Vercel read the
 *     file at all.
 *
 * **What this module does NOT prove.** Applying the rules here is applying our
 * reading of them. Vercel's own matcher is path-to-regexp and this is a subset
 * of it — enough for the patterns this file uses and deliberately no more, so
 * that a pattern it cannot parse throws rather than quietly matching nothing.
 * (A config-shaped change that matched zero files, with every local gate green,
 * is the failure `wave-zero.md` §10a names twice.) Whether the deployed host
 * honours the rules is a measurement taken against the deployment; see
 * `docs/deploy.md` §7.
 *
 * **And one ordering fact that this module must never paper over.** Vercel
 * applies `rewrites` only AFTER the filesystem check — a `source` that names a
 * real file in the build output can never be rewritten — while `headers` rules
 * decorate whatever the filesystem serves. W2's first `vercel.json` broke on
 * exactly that seam: it rewrote `/dict-….sqlite` to its `.br` sibling and set
 * `content-encoding: br` on the same path, and on the deployed host only the
 * second half would have fired, serving 43 MB of raw SQLite labelled brotli.
 * `tests/unit/server/routes.test.ts` now refuses any rewrite whose `source`
 * matches a file in `dist/`, and any `content-encoding` header on a path that
 * is one.
 *
 * Node-only: `readHostConfig()` reads the filesystem. The matcher half is pure
 * and is what the tests drive.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface HostCondition {
  type: 'header' | 'query' | 'cookie' | 'host';
  key: string;
  /** A regular expression matched against the value, per Vercel's schema. */
  value?: string;
}

export interface HostHeaderRule {
  source: string;
  has?: HostCondition[];
  missing?: HostCondition[];
  headers: { key: string; value: string }[];
}

export interface HostRewriteRule {
  source: string;
  has?: HostCondition[];
  missing?: HostCondition[];
  destination: string;
}

export interface HostConfig {
  framework: string | null;
  buildCommand?: string;
  outputDirectory?: string;
  rewrites: HostRewriteRule[];
  headers: HostHeaderRule[];
}

export const HOST_CONFIG_FILE = 'vercel.json';

/** Read `<appRoot>/vercel.json`. Throws if it is gone — that is the point. */
export function readHostConfig(appRoot: string): HostConfig {
  const path = resolve(appRoot, HOST_CONFIG_FILE);
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Partial<HostConfig>;
  return {
    framework: parsed.framework ?? null,
    ...(parsed.buildCommand === undefined ? {} : { buildCommand: parsed.buildCommand }),
    ...(parsed.outputDirectory === undefined ? {} : { outputDirectory: parsed.outputDirectory }),
    rewrites: parsed.rewrites ?? [],
    headers: parsed.headers ?? [],
  };
}

const REGEX_SPECIALS = new Set([
  '.', '+', '*', '?', '^', '$', '{', '}', '|', '[', ']', '\\', '/',
]);

/**
 * One `source` pattern, as a regular expression anchored at both ends.
 *
 * The supported subset, which is exactly what `vercel.json` uses:
 *
 * - `:name(<pattern>)` — a named parameter with an explicit pattern.
 * - `:name` — a named parameter matching one path segment.
 * - `(<pattern>)` — a bare group, which is how the SPA fallback writes its
 *   negative lookahead.
 *
 * Anything else is literal and is escaped. A `*`, `+` or `?` **modifier**
 * after a parameter (path-to-regexp's repeat forms) is deliberately NOT
 * supported: it changes how many segments a parameter eats, and silently
 * mis-parsing that is the class of bug this module's header warns about. It
 * throws instead.
 */
export function sourceToRegExp(source: string): { regex: RegExp; params: string[] } {
  const params: string[] = [];
  let out = '';
  let i = 0;
  while (i < source.length) {
    const char = source[i];

    if (char === ':') {
      const name = /^[A-Za-z0-9_]+/.exec(source.slice(i + 1))?.[0];
      if (!name) throw new Error(`host-config: ":" with no parameter name in ${source}`);
      i += 1 + name.length;
      let pattern = '[^/]+';
      if (source[i] === '(') {
        const [group, next] = readGroup(source, i);
        pattern = group;
        i = next;
      }
      if (source[i] === '*' || source[i] === '+' || source[i] === '?') {
        throw new Error(`host-config: unsupported "${source[i]}" modifier in ${source}`);
      }
      params.push(name);
      out += `(${pattern})`;
      continue;
    }

    if (char === '(') {
      const [group, next] = readGroup(source, i);
      i = next;
      if (source[i] === '*' || source[i] === '+' || source[i] === '?') {
        throw new Error(`host-config: unsupported "${source[i]}" modifier in ${source}`);
      }
      params.push(String(params.length + 1));
      out += `(${group})`;
      continue;
    }

    out += REGEX_SPECIALS.has(char) ? `\\${char}` : char;
    i += 1;
  }
  return { regex: new RegExp(`^${out}$`), params };
}

/** Read the balanced `(...)` starting at `start`; returns its body and the index after it. */
function readGroup(source: string, start: number): [string, number] {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '\\') {
      i += 1;
      continue;
    }
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return [source.slice(start + 1, i), i + 1];
    }
  }
  throw new Error(`host-config: unbalanced "(" in ${source}`);
}

/** Request facts a `has`/`missing` condition can be evaluated against. */
export interface HostRequest {
  pathname: string;
  headers?: Record<string, string | undefined>;
}

function conditionHolds(condition: HostCondition, request: HostRequest): boolean {
  if (condition.type !== 'header') {
    throw new Error(`host-config: unsupported condition type "${condition.type}"`);
  }
  const value = request.headers?.[condition.key.toLowerCase()];
  if (value === undefined) return false;
  if (condition.value === undefined) return true;
  return new RegExp(condition.value).test(value);
}

/**
 * Does this rule apply to this request, and with what captures?
 *
 * Exported because `vite-plugins/headers.ts` needs to ask whether the SPA
 * fallback covers a path without applying it, and because the test that keeps
 * `vercel.json` honest asks the same question of every rule.
 */
export function matchRule(
  rule: { source: string; has?: HostCondition[]; missing?: HostCondition[] },
  request: HostRequest,
): RegExpExecArray | null {
  const match = sourceToRegExp(rule.source).regex.exec(request.pathname);
  if (!match) return null;
  if (rule.has?.some((condition) => !conditionHolds(condition, request))) return null;
  if (rule.missing?.some((condition) => conditionHolds(condition, request))) return null;
  return match;
}

/**
 * Every header the host would send for this request, lowercased.
 *
 * All matching rules apply and a later rule wins on a repeated key — which is
 * what makes the `.br` rule a two-line addition to the artifact's rule rather
 * than a duplicate of it.
 */
export function headersFor(config: HostConfig, request: HostRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of config.headers) {
    if (!matchRule(rule, request)) continue;
    for (const { key, value } of rule.headers) out[key.toLowerCase()] = value;
  }
  return out;
}

/**
 * The path this request is rewritten to, or null.
 *
 * The **first** matching rewrite wins and the result is not re-matched, which
 * is Vercel's own behaviour and also the only reading under which the `.br`
 * negotiation cannot loop.
 */
export function rewriteFor(config: HostConfig, request: HostRequest): string | null {
  for (const rule of config.rewrites) {
    const match = matchRule(rule, request);
    if (!match) continue;
    const { params } = sourceToRegExp(rule.source);
    let destination = rule.destination;
    params.forEach((name, index) => {
      const captured = match[index + 1] ?? '';
      destination = /^[0-9]+$/.test(name)
        ? destination.replaceAll(`$${name}`, captured)
        : destination.replace(new RegExp(`:${name}(?![A-Za-z0-9_])`, 'g'), captured);
    });
    return destination;
  }
  return null;
}
