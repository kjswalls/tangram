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
 *    and either the one now first is on the preferred list and the other is
 *    not, or the one that was first got there only through what the step
 *    removed: a place on the previous list, or a band that no longer counts
 *    because every gloss of its entry is a cross-reference. The step records
 *    the lists it went between (`PreferredParams`), so the same rule re-blesses
 *    every later edit to `preferred-readings.ts`.
 *
 * Under either rule a list may not gain, lose or duplicate an id, and a swap the
 * rule demands between two readings of one headword must actually have been
 * made. Anything else is a change the rule does not explain, which is a bug,
 * not a golden to update.
 */
import { createHash } from 'node:crypto';

import { isCrossReferenceOnly, orderingBand } from '../apps/app/lib/dict/rank';
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
 * What a preferred-reading re-bless changed, as `rebless.json` records it: the
 * list of preferred ids before and after, and whether the cross-reference
 * exception was already in force before. The first such step goes from no list
 * and no exception to both. A later edit to `preferred-readings.ts` goes from
 * one list to the next, with the exception in force on both sides.
 *
 * The lists are recorded rather than read from `preferred-readings.ts`, so that
 * a step stays provable after the list moves on. The live `compareEntries` is
 * checked against the latest step instead (`tokensInOrder`), which is what makes
 * an unrecorded list edit fail the suite rather than pass it.
 */
export interface PreferredParams {
  preferredBefore: string[];
  preferredAfter: string[];
  crossReferenceBefore: boolean;
}

/** `compareEntries`, rebuilt from a recorded list: the order a step blessed. */
export function preferredOrder(preferred: ReadonlySet<string>, crossReference: boolean): Order {
  const band = (entry: DictEntry) =>
    crossReference ? orderingBand(entry) : (entry.hskBand ?? NO_BAND);
  return (a, b) =>
    (b.freq ?? -1) - (a.freq ?? -1) ||
    Number(a.isVariant) - Number(b.isVariant) ||
    Number(a.properNoun) - Number(b.properNoun) ||
    Number(preferred.has(b.id)) - Number(preferred.has(a.id)) ||
    band(a) - band(b) ||
    (a.id < b.id ? -1 : 1);
}

export const PREFERRED_RULE_NAME = 'preferred-and-cross-reference';

/**
 * The second kind of re-bless: a preferred reading goes before the band, and a
 * cross-reference-only entry's band no longer counts.
 *
 * A swap is licensed only between entries that tie on frequency, variant and
 * proper noun, where the entry now first is on the new list and the other is
 * not, or where neither is and the one that was first got there only through
 * something this step removed (its place on the old list, or a band the
 * cross-reference exception no longer counts) and the band-then-id order now
 * puts the other first.
 */
export function preferredRule(params: PreferredParams): OrderRule {
  const before = new Set(params.preferredBefore);
  const after = new Set(params.preferredAfter);
  const beforeOrder = preferredOrder(before, params.crossReferenceBefore);
  return {
    name: PREFERRED_RULE_NAME,
    before: beforeOrder,
    after: preferredOrder(after, true),
    swapComplaint(a, b) {
      const pair = `${describe(a)} ⇄ ${describe(b)}`;
      const earlier = earlierKeyComplaint(a, b, pair);
      if (earlier) return earlier;
      if (!(beforeOrder(a, b) < 0)) return `${pair}: the old order did not put the first of them first`;
      if (after.has(b.id) !== after.has(a.id)) {
        return after.has(b.id) ? undefined : `${pair}: the preferred reading moved behind the other`;
      }
      const bandA = orderingBand(a);
      const bandB = orderingBand(b);
      if (!(bandB < bandA || (bandB === bandA && b.id < a.id))) {
        return `${pair}: nothing in this step puts the entry now first ahead`;
      }
      if (before.has(a.id) && !before.has(b.id)) return undefined;
      if (!params.crossReferenceBefore && lostItsBand(a)) return undefined;
      return `${pair}: neither the list nor the cross-reference exception explains it`;
    },
  };
}

/** Every rule a committed re-bless may name, by the name `rebless.json` records. */
export function ruleFor(step: Pick<ReblessStep, 'rule' | 'params'>): OrderRule {
  if (step.rule === BAND_RULE.name) return BAND_RULE;
  if (step.rule === PREFERRED_RULE_NAME && step.params) return preferredRule(step.params);
  throw new Error(`rebless.json names a rule the checker does not know: ${step.rule}`);
}

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

/**
 * The segmenter's readings are already in `order`. Passed the latest step's
 * `after`, this is the check that the live `compareEntries` is the order the
 * record last blessed.
 */
export function tokensInOrder(tokens: readonly TokenLike[], lookup: Lookup, order: Order): boolean {
  return JSON.stringify(reorderReadings(tokens, lookup, order)) === JSON.stringify(tokens);
}

/**
 * One re-bless: every field it changed, its value before and after, and a
 * canonical digest of each whole fixture as it was — so a test can put the
 * `before` values back and prove the record names *every* change, not only the
 * ones it chose to list.
 */
export interface ReblessStep {
  /** The rule's name (`ruleFor`): the only reason this step may have moved anything. */
  rule: string;
  /** For a preferred-reading step, the lists it went between. */
  params?: PreferredParams;
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
