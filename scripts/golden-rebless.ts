/**
 * What a golden re-bless is allowed to change, stated as code rather than as a
 * reviewer's reading of a diff.
 *
 * The fixtures under `apps/app/tests/unit/dict/golden/` and
 * `apps/app/tests/unit/ai/golden/` froze what the JSON implementation answered
 * before `data.md` D6 deleted it. Nothing can regenerate the deleted answers, so
 * a change to the dictionary's **reading order** — the HSK-band tie-break in
 * `compareEntries` (`apps/app/lib/dict/rank.ts`, HANDOFF.md "The default
 * reading") — has to move the fixtures by a mechanism that cannot also carry a
 * bug in with it. This module is that mechanism, and it is used twice:
 * `scripts/freeze-golden.ts` refuses to write a fixture it cannot explain, and
 * `tests/unit/dict/golden-rebless.test.ts` re-proves the committed re-bless on
 * every `pnpm test`.
 *
 * **The rule.** Two entries may swap places only if they tie on every key the
 * old order compared before the id — frequency, variant, proper noun — and the
 * new order puts the lower HSK band first, where the old one had put the lower
 * id first. A list may not gain, lose or duplicate an id. Anything else is a
 * change the ranking rule does not explain, which is a bug, not a golden to
 * update.
 */
import { createHash } from 'node:crypto';

import { compareEntries } from '../apps/app/lib/dict/rank';
import type { DictEntry, EntryId } from '../apps/app/lib/dict/types';

/** Beyond every real band, exactly as `rank.ts` folds a missing one. */
const NO_BAND = 8;

/**
 * `compareEntries` as it was before the band tie-break, kept so the proof can
 * reproduce the old fixtures from today's answers. Not used by anything that
 * ships.
 */
export function compareEntriesBeforeBand(a: DictEntry, b: DictEntry): number {
  return (
    (b.freq ?? -1) - (a.freq ?? -1) ||
    Number(a.isVariant) - Number(b.isVariant) ||
    Number(a.properNoun) - Number(b.properNoun) ||
    (a.id < b.id ? -1 : 1)
  );
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

type Lookup = (id: EntryId) => DictEntry | undefined;

function describe(entry: DictEntry): string {
  return `${entry.id} (freq ${entry.freq ?? '-'}, band ${entry.hskBand ?? '-'}${
    entry.isVariant ? ', variant' : ''
  }${entry.properNoun ? ', proper noun' : ''})`;
}

/**
 * Why `a` and `b` may have swapped, or the reason they may not.
 *
 * `a` came first before and `b` comes first now.
 */
function swapComplaint(a: DictEntry, b: DictEntry): string | undefined {
  const pair = `${describe(a)} ⇄ ${describe(b)}`;
  if ((a.freq ?? -1) !== (b.freq ?? -1)) return `${pair}: different frequencies`;
  if (a.isVariant !== b.isVariant) return `${pair}: one is a variant`;
  if (a.properNoun !== b.properNoun) return `${pair}: one is a proper noun`;
  if (!((b.hskBand ?? NO_BAND) < (a.hskBand ?? NO_BAND))) {
    return `${pair}: the new order does not put the lower band first`;
  }
  if (!(a.id < b.id)) return `${pair}: the old order did not put the lower id first`;
  return undefined;
}

/**
 * Every way `after` differs from `before` that the band tie-break does not
 * explain. Empty means the change is exactly the rule.
 *
 * Checked pairwise over every pair the two lists order differently, not only
 * adjacent ones: a list is a permutation explained by the rule if and only if
 * every inversion is one the rule licenses.
 */
export function unexplainedListChange(
  before: readonly EntryId[],
  after: readonly EntryId[],
  lookup: Lookup,
  label: string,
): string[] {
  const complaints: string[] = [];
  if (new Set(before).size !== before.length || new Set(after).size !== after.length) {
    complaints.push(`${label}: a list holds a duplicate id`);
  }
  const sortedBefore = [...before].sort();
  const sortedAfter = [...after].sort();
  if (sortedBefore.join('\n') !== sortedAfter.join('\n')) {
    const gone = before.filter((id) => !after.includes(id));
    const added = after.filter((id) => !before.includes(id));
    complaints.push(`${label}: not a reordering — lost [${gone.join(', ')}], gained [${added.join(', ')}]`);
    return complaints;
  }
  const position = new Map(after.map((id, index) => [id, index]));
  for (let i = 0; i < before.length; i += 1) {
    for (let j = i + 1; j < before.length; j += 1) {
      if ((position.get(before[i]) as number) < (position.get(before[j]) as number)) continue;
      const a = lookup(before[i]);
      const b = lookup(before[j]);
      if (!a || !b) {
        complaints.push(`${label}: ${a ? before[j] : before[i]} is not in the dictionary`);
        continue;
      }
      const complaint = swapComplaint(a, b);
      if (complaint) complaints.push(`${label}: ${complaint}`);
    }
  }
  // The other half: a swap the rule demands and the list did not make. Only
  // between readings of one headword (a shared simp or trad) — a list that
  // concatenates several words orders the words by position, not by rank.
  for (let i = 0; i < after.length; i += 1) {
    for (let j = i + 1; j < after.length; j += 1) {
      const a = lookup(after[i]);
      const b = lookup(after[j]);
      if (!a || !b || (a.simp !== b.simp && a.trad !== b.trad)) continue;
      if (compareEntriesBeforeBand(a, b) === compareEntries(a, b)) continue;
      if (compareEntries(a, b) > 0) {
        complaints.push(`${label}: ${describe(b)} should now come before ${describe(a)}`);
      }
    }
  }
  return complaints;
}

/** The token shape the segmenter emits; only `entryIds` is touched. */
export interface TokenLike {
  entryIds?: readonly EntryId[];
}

/**
 * The same tokens with every token's readings re-sorted by `order`.
 *
 * Property order inside each token is kept, so `JSON.stringify` of the result
 * is byte-comparable with a digest taken of the segmenter's own output.
 */
export function reorderReadings<T extends TokenLike>(
  tokens: readonly T[],
  lookup: Lookup,
  order: (a: DictEntry, b: DictEntry) => number,
): T[] {
  return tokens.map((token) => {
    if (!token.entryIds) return token;
    const entries = token.entryIds.map((id) => {
      const entry = lookup(id);
      if (!entry) throw new Error(`token reading ${id} is not in the dictionary`);
      return entry;
    });
    return { ...token, entryIds: entries.sort(order).map((entry) => entry.id) };
  });
}

/**
 * Proof for a digest over segmenter tokens: today's tokens are already in the
 * new order, re-sorting their readings by the old order reproduces the old
 * digest byte for byte, and they themselves hash to the new one. Together that
 * says the only thing that moved is the order of readings inside a token —
 * no cut, no offset, no reading gained or lost.
 */
export function unexplainedTokenDigest(
  tokens: readonly TokenLike[],
  lookup: Lookup,
  before: string,
  after: string,
): string[] {
  const complaints: string[] = [];
  const now = JSON.stringify(tokens);
  if (JSON.stringify(reorderReadings(tokens, lookup, compareEntries)) !== now) {
    complaints.push('the segmenter’s readings are not in compareEntries order');
  }
  const old = sha256(JSON.stringify(reorderReadings(tokens, lookup, compareEntriesBeforeBand)));
  if (old !== before) {
    complaints.push(`re-sorting today's readings the old way gives ${old}, not the old digest ${before}`);
  }
  if (sha256(now) !== after) complaints.push(`today's tokens hash to ${sha256(now)}, not ${after}`);
  return complaints;
}

/**
 * The record `freeze-golden.ts` writes beside the fixtures: every field a
 * re-bless changed, its value before and after, and a canonical digest of each
 * whole fixture as it was — so a test can put the `before` values back and
 * prove the record names *every* change, not only the ones it chose to list.
 */
export interface ReblessRecord {
  reason: string;
  /** The files, relative to the workspace root, and their canonical digests before. */
  files: Record<string, { beforeCanonicalSha256: string }>;
  changes: {
    file: string;
    /** JSON path into the fixture, e.g. `["candidateEntries", 1, "ids"]`. */
    path: (string | number)[];
    kind: 'ids' | 'tokenDigest';
    before: unknown;
    after: unknown;
  }[];
}

/** `JSON.stringify` with object keys sorted — whitespace and key order cannot move it. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

export function getPath(root: unknown, path: readonly (string | number)[]): unknown {
  let node = root;
  for (const step of path) node = (node as Record<string | number, unknown>)[step];
  return node;
}

export function setPath(root: unknown, path: readonly (string | number)[], value: unknown): void {
  let node = root as Record<string | number, unknown>;
  for (const step of path.slice(0, -1)) node = node[step] as Record<string | number, unknown>;
  node[path[path.length - 1]] = value;
}

/**
 * Every leaf-level difference between two fixtures, as paths. Arrays of
 * strings are compared whole (an id list is one expectation); everything else
 * recurses.
 */
export function differingPaths(
  before: unknown,
  after: unknown,
  path: (string | number)[] = [],
): (string | number)[][] {
  if (canonical(before) === canonical(after)) return [];
  const isStringList = (value: unknown) =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (
    before === null ||
    after === null ||
    typeof before !== 'object' ||
    typeof after !== 'object' ||
    (isStringList(before) && isStringList(after)) ||
    Array.isArray(before) !== Array.isArray(after)
  ) {
    return [path];
  }
  const keys = new Set([
    ...Object.keys(before as Record<string, unknown>),
    ...Object.keys(after as Record<string, unknown>),
  ]);
  const out: (string | number)[][] = [];
  for (const key of keys) {
    const step = Array.isArray(before) ? Number(key) : key;
    out.push(
      ...differingPaths(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        [...path, step],
      ),
    );
  }
  return out;
}
