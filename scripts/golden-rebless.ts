/**
 * What a golden re-bless is allowed to change, stated as code rather than as a
 * reviewer's reading of a diff.
 *
 * The fixtures under `apps/app/tests/unit/dict/golden/` and
 * `apps/app/tests/unit/ai/golden/` froze what the JSON implementation answered
 * before `data.md` D6 deleted it. Nothing can regenerate the deleted answers, so
 * a change to the dictionary's **reading order** — `compareEntries`
 * (`apps/app/lib/dict/rank.ts`) — has to move the fixtures by a mechanism that
 * cannot also carry a bug in with it. This module is that mechanism, and it is
 * used twice: `scripts/freeze-golden.ts` refuses to write a fixture it cannot
 * explain, and `tests/unit/dict/golden-rebless.test.ts` re-proves every
 * committed re-bless on every `pnpm test`.
 *
 * **Each re-bless is one `OrderRule`**: the order the fixtures held, the order
 * they hold after, and the only reason two entries may have swapped. There have
 * been two, and `golden/rebless.json` records them as a chain:
 *
 * 1. `band` (HANDOFF.md "The default reading"). Two entries may swap only if
 *    they tie on frequency, variant and proper noun, and the new order puts the
 *    lower HSK band first where the old one had put the lower id first.
 * 2. `preferred-and-cross-reference` (HANDOFF.md "Preferred readings"). Two
 *    entries may swap only if they tie on frequency, variant and proper noun,
 *    and either the one now first is on `preferred-readings.ts`'s list and the
 *    other is not, or the one that was first had a band only because the band
 *    counted for an entry whose every gloss is a cross-reference, and the order
 *    without that band puts the other first.
 *
 * Under either rule a list may not gain, lose or duplicate an id, and a swap the
 * rule demands between two readings of one headword must actually have been
 * made. Anything else is a change the rule does not explain, which is a bug,
 * not a golden to update.
 */
import { createHash } from 'node:crypto';

import {
  compareEntries,
  isCrossReferenceOnly,
  isPreferredReading,
  orderingBand,
} from '../apps/app/lib/dict/rank';
import type { DictEntry, EntryId } from '../apps/app/lib/dict/types';

/** Beyond every real band, exactly as `rank.ts` folds a missing one. */
const NO_BAND = 8;

type Order = (a: DictEntry, b: DictEntry) => number;

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

/**
 * `compareEntries` as the band re-bless left it: before the preferred readings
 * and the cross-reference exception. Kept for the same reason. Not used by
 * anything that ships.
 */
export function compareEntriesWithBand(a: DictEntry, b: DictEntry): number {
  return (
    (b.freq ?? -1) - (a.freq ?? -1) ||
    Number(a.isVariant) - Number(b.isVariant) ||
    Number(a.properNoun) - Number(b.properNoun) ||
    (a.hskBand ?? NO_BAND) - (b.hskBand ?? NO_BAND) ||
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

/** The keys every rule so far has left alone: a swap across them is never explained. */
function earlierKeyComplaint(a: DictEntry, b: DictEntry, pair: string): string | undefined {
  if ((a.freq ?? -1) !== (b.freq ?? -1)) return `${pair}: different frequencies`;
  if (a.isVariant !== b.isVariant) return `${pair}: one is a variant`;
  if (a.properNoun !== b.properNoun) return `${pair}: one is a proper noun`;
  return undefined;
}

/**
 * One change of reading order, as the proof needs it: the order before, the
 * order after, and why `a` (first before) and `b` (first now) may have swapped,
 * or the reason they may not.
 */
export interface OrderRule {
  name: string;
  before: Order;
  after: Order;
  swapComplaint(a: DictEntry, b: DictEntry): string | undefined;
}

/** The first re-bless: the HSK band broke the tie before the id. */
export const BAND_RULE: OrderRule = {
  name: 'band',
  before: compareEntriesBeforeBand,
  after: compareEntriesWithBand,
  swapComplaint(a, b) {
    const pair = `${describe(a)} ⇄ ${describe(b)}`;
    const earlier = earlierKeyComplaint(a, b, pair);
    if (earlier) return earlier;
    if (!((b.hskBand ?? NO_BAND) < (a.hskBand ?? NO_BAND))) {
      return `${pair}: the new order does not put the lower band first`;
    }
    if (!(a.id < b.id)) return `${pair}: the old order did not put the lower id first`;
    return undefined;
  },
};

/** A band that the cross-reference exception no longer counts. */
function lostItsBand(entry: DictEntry): boolean {
  return entry.hskBand !== undefined && isCrossReferenceOnly(entry);
}

/**
 * The second re-bless: a preferred reading goes before the band, and a
 * cross-reference-only entry's band no longer counts. `after` is the live
 * `compareEntries`; a third re-bless freezes a copy of it first, as
 * `compareEntriesWithBand` froze the first.
 */
export const PREFERRED_RULE: OrderRule = {
  name: 'preferred-and-cross-reference',
  before: compareEntriesWithBand,
  after: compareEntries,
  swapComplaint(a, b) {
    const pair = `${describe(a)} ⇄ ${describe(b)}`;
    const earlier = earlierKeyComplaint(a, b, pair);
    if (earlier) return earlier;
    const preferredA = isPreferredReading(a);
    const preferredB = isPreferredReading(b);
    if (preferredB && !preferredA) return undefined;
    if (preferredA && !preferredB) return `${pair}: the preferred reading moved behind the other`;
    if (!lostItsBand(a)) {
      return lostItsBand(b)
        ? `${pair}: only the entry now first lost its band, and losing a band cannot move it ahead`
        : `${pair}: neither is a preferred reading and neither lost a band`;
    }
    const bandA = orderingBand(a);
    const bandB = orderingBand(b);
    if (!(bandB < bandA || (bandB === bandA && b.id < a.id))) {
      return `${pair}: without its cross-reference band, the old first still sorts first`;
    }
    return undefined;
  },
};

/** Every rule a committed re-bless may name, by the name `rebless.json` records. */
export const ORDER_RULES: Record<string, OrderRule> = {
  [BAND_RULE.name]: BAND_RULE,
  [PREFERRED_RULE.name]: PREFERRED_RULE,
};

/**
 * Every way `after` differs from `before` that `rule` does not explain. Empty
 * means the change is exactly the rule.
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
  rule: OrderRule,
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
      const complaint = rule.swapComplaint(a, b);
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
      if (rule.before(a, b) === rule.after(a, b)) continue;
      if (rule.after(a, b) > 0) {
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
 * Proof for a digest over segmenter tokens: re-sorting their readings by
 * `rule.before` reproduces the old digest byte for byte, and by `rule.after` the
 * new one. Together that says the only thing that moved is the order of
 * readings inside a token — no cut, no offset, no reading gained or lost.
 *
 * That alone would bless *any* reordering, because `rule.after` is the order
 * being tested — a `compareEntries` that sorted by id backwards would reproduce
 * its own digest. So every token whose readings moved is also put through
 * `unexplainedListChange`, which holds each swap to `rule.swapComplaint`.
 *
 * The tokens are today's. Re-sorting rather than taking them as they are is what
 * lets an older step in the chain be re-proved after a later one moved the
 * order again; for the latest step, `tokensInCurrentOrder` checks the tokens
 * are already in it.
 */
export function unexplainedTokenDigest(
  tokens: readonly TokenLike[],
  lookup: Lookup,
  before: string,
  after: string,
  rule: OrderRule,
): string[] {
  const complaints: string[] = [];
  const old = sha256(JSON.stringify(reorderReadings(tokens, lookup, rule.before)));
  if (old !== before) {
    complaints.push(`re-sorting today's readings the old way gives ${old}, not the old digest ${before}`);
  }
  const reordered = reorderReadings(tokens, lookup, rule.after);
  const now = sha256(JSON.stringify(reordered));
  if (now !== after) complaints.push(`re-sorting today's readings the new way gives ${now}, not ${after}`);
  const oldOrder = reorderReadings(tokens, lookup, rule.before);
  oldOrder.forEach((token, i) => {
    const was = token.entryIds ?? [];
    const is = reordered[i].entryIds ?? [];
    if (was.join('\n') === is.join('\n')) return;
    complaints.push(...unexplainedListChange(was, is, lookup, `token ${i}`, rule));
  });
  return complaints;
}

/** The segmenter's readings are already in `compareEntries` order. */
export function tokensInCurrentOrder(tokens: readonly TokenLike[], lookup: Lookup): boolean {
  return (
    JSON.stringify(reorderReadings(tokens, lookup, compareEntries)) === JSON.stringify(tokens)
  );
}

/**
 * One re-bless: every field it changed, its value before and after, and a
 * canonical digest of each whole fixture as it was — so a test can put the
 * `before` values back and prove the record names *every* change, not only the
 * ones it chose to list.
 */
export interface ReblessStep {
  /** A key of `ORDER_RULES`: the only reason this step may have moved anything. */
  rule: string;
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

/**
 * The record `freeze-golden.ts` keeps beside the fixtures: every re-bless, oldest
 * first. Undoing them newest first must walk the fixtures back to the ones the
 * JSON implementation wrote.
 */
export interface ReblessRecord {
  steps: ReblessStep[];
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
