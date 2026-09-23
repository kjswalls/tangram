// @vitest-environment node
/**
 * The golden fixtures were re-blessed for changes of reading order, and this
 * re-proves, on every run, that each re-bless moved nothing else.
 *
 * `compareEntries` gained an HSK-band tie-break (HANDOFF.md "The default
 * reading"), and then a hand-kept list of preferred readings and an exception
 * for cross-reference-only entries (HANDOFF.md "Preferred readings"). The
 * fixtures cannot be regenerated from the implementation that first answered
 * them — `data.md` D6 deleted it — so `scripts/freeze-golden.ts` re-blessed them
 * under one rule each time, and wrote down what it changed in
 * `golden/rebless.json`, a chain of steps. Three things are proved here from
 * that record and the dictionary on disk:
 *
 *  1. **The record names every change.** Undoing the steps newest first —
 *     putting each `before` back — walks today's fixtures back through every
 *     earlier state, to a canonical digest the generator took before writing
 *     each one. A change the record left out would make a digest differ.
 *  2. **Every change is its step's rule and nothing else.** An id list is only
 *     reordered, and only as the rule allows. The passage digest is reproduced
 *     byte for byte by re-sorting today's readings the step's old and new ways,
 *     and each token's reordering is held to the rule pair by pair.
 *  3. **The checker is not vacuous.** It rejects, under each rule, the swaps the
 *     rule does not license, a swap the rule demanded and the list did not
 *     make, a lost id and a moved token.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DictEntry } from '@/lib/dict/types';
import { workspaceRoot, dirOf } from '@/lib/server/roots';
import {
  BAND_RULE,
  canonical,
  compareEntriesWithBand,
  getPath,
  ORDER_RULES,
  PREFERRED_RULE,
  reorderReadings,
  setPath,
  sha256,
  tokensInCurrentOrder,
  unexplainedListChange,
  unexplainedTokenDigest,
  type OrderRule,
  type ReblessRecord,
} from '../../../../../scripts/golden-rebless';
import { passageTokens } from '../../../../../scripts/freeze-golden';
import { goldenIsFresh, STALE_HINT } from './golden';
import { getEntry } from './json-oracle';
import { requireDictData } from './data-required';
import record from './golden/rebless.json';

requireDictData();

const ROOT = workspaceRoot(dirOf(import.meta.url));
const rebless = record as ReblessRecord;

function fixture(file: string): unknown {
  return JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'));
}

describe('the reading-order re-blesses of the golden fixtures', () => {
  it('were cut from the dictionary on disk', () => {
    expect(goldenIsFresh(), STALE_HINT).toBe(true);
  });

  it('are the two rules, in order, each naming a rule the checker knows', () => {
    expect(rebless.steps.map((step) => step.rule)).toEqual([BAND_RULE.name, PREFERRED_RULE.name]);
    for (const step of rebless.steps) expect(ORDER_RULES[step.rule]).toBeDefined();
  });

  it('record every change they made: undone newest first, each step lands on its own digest', () => {
    const files = Object.keys(rebless.steps[0].files);
    expect(files.length).toBe(2);
    const state = new Map(files.map((file) => [file, fixture(file)]));
    for (const step of [...rebless.steps].reverse()) {
      expect(Object.keys(step.files).sort()).toEqual([...files].sort());
      expect(step.changes.length).toBeGreaterThan(0);
      for (const file of files) {
        const now = state.get(file);
        for (const change of step.changes.filter((one) => one.file === file)) {
          expect(getPath(now, change.path), `${step.rule} ${file} ${JSON.stringify(change.path)}`).toEqual(
            change.after,
          );
          setPath(now, change.path, change.before);
        }
        expect(
          sha256(canonical(now)),
          `${step.rule} ${file}: a change the record does not name`,
        ).toBe(step.files[file].beforeCanonicalSha256);
      }
    }
  });

  it('changed id lists only where their rule says, and only by reordering', () => {
    for (const step of rebless.steps) {
      const rule = ORDER_RULES[step.rule];
      for (const change of step.changes.filter((one) => one.kind === 'ids')) {
        const label = `${step.rule} ${change.file} ${JSON.stringify(change.path)}`;
        expect(
          unexplainedListChange(
            change.before as string[],
            change.after as string[],
            getEntry,
            label,
            rule,
          ),
        ).toEqual([]);
        expect(change.after, `${label}: nothing actually moved`).not.toEqual(change.before);
      }
    }
  });

  it('changed the passage digest only by the order of readings inside a token', () => {
    const tokens = passageTokens(20_000);
    expect(tokensInCurrentOrder(tokens, getEntry)).toBe(true);
    for (const step of rebless.steps) {
      const digests = step.changes.filter((change) => change.kind === 'tokenDigest');
      expect(digests.length, step.rule).toBe(1);
      expect(
        unexplainedTokenDigest(
          tokens,
          getEntry,
          digests[0].before as string,
          digests[0].after as string,
          ORDER_RULES[step.rule],
        ),
      ).toEqual([]);
    }
  }, 120_000);

  it('start each step where the one before it ended', () => {
    const [band, preferred] = rebless.steps;
    const bandDigest = band.changes.find((change) => change.kind === 'tokenDigest');
    const preferredDigest = preferred.changes.find((change) => change.kind === 'tokenDigest');
    expect(preferredDigest?.before).toBe(bandDigest?.after);
  });
});

describe('the checker behind it: the band rule', () => {
  // 个: gè (band 1) and gě (no band) tie on every earlier key — the swap the rule
  // licenses. 我 is a different frequency entirely.
  const GE3 = '個|个[ge3]';
  const GE4 = '個|个[ge4]';
  const WO = '我|我[wo3]';
  const check = (before: string[], after: string[]) =>
    unexplainedListChange(before, after, getEntry, 't', BAND_RULE);

  it('accepts the swap the rule licenses', () => {
    expect(check([WO, GE3, GE4], [WO, GE4, GE3])).toEqual([]);
  });

  it('rejects the same swap made the other way', () => {
    expect(check([WO, GE4, GE3], [WO, GE3, GE4])).not.toEqual([]);
  });

  it('rejects a list that should have swapped and did not', () => {
    expect(check([WO, GE3, GE4], [WO, GE3, GE4])).not.toEqual([]);
  });

  it('rejects a swap across frequencies', () => {
    expect(check([WO, GE4], [GE4, WO])).not.toEqual([]);
  });

  it('rejects a lost, gained or duplicated id', () => {
    expect(check([WO, GE3, GE4], [WO, GE4])).not.toEqual([]);
    expect(check([WO, GE4], [WO, GE4, GE3])).not.toEqual([]);
    expect(check([WO, GE4], [WO, GE4, GE4])).not.toEqual([]);
  });

  it('rejects a token change that is not a reordering of readings', () => {
    const tokens = passageTokens(400);
    const after = sha256(JSON.stringify(reorderReadings(tokens, getEntry, BAND_RULE.after)));
    const before = sha256(JSON.stringify(reorderReadings(tokens, getEntry, BAND_RULE.before)));
    const moved = tokens.map((token, i) => (i === 3 ? { ...token, end: token.end + 1 } : token));
    expect(
      unexplainedTokenDigest(moved, getEntry, before, sha256(JSON.stringify(moved)), BAND_RULE),
    ).not.toEqual([]);
    // …and accepts the same tokens unmoved, so the rejection above is the move.
    expect(unexplainedTokenDigest(tokens, getEntry, before, after, BAND_RULE)).toEqual([]);
  }, 60_000);
});

/**
 * A mutant `compareEntries`: the band order, but with the id tie-break
 * reversed. It ignores the preferred list and would reproduce its own digest.
 */
function lastTieBackwards(a: DictEntry, b: DictEntry): number {
  const order = compareEntriesWithBand(a, b);
  const tiedDownToTheId =
    (a.freq ?? -1) === (b.freq ?? -1) &&
    a.isVariant === b.isVariant &&
    a.properNoun === b.properNoun &&
    a.hskBand === b.hskBand;
  return tiedDownToTheId ? -order : order;
}

describe('the checker behind it: the preferred-reading and cross-reference rule', () => {
  // 壳: qiào (band 7–9) was first; ké is on the preferred list.
  const QIAO = '殼|壳[qiao4]';
  const KE = '殼|壳[ke2]';
  // 尽可能: the band-5 jìn says only "see 儘可能…"; jǐn has no band.
  const JIN4 = '盡可能|尽可能[jin4 ke3 neng2]';
  const JIN3 = '儘可能|尽可能[jin3 ke3 neng2]';
  // 看: kàn (band 1) before kān (band 6) — neither rule touches it.
  const KAN4 = '看|看[kan4]';
  const KAN1 = '看|看[kan1]';
  // 个: the band rule's swap, which this rule does not license again.
  const GE3 = '個|个[ge3]';
  const GE4 = '個|个[ge4]';
  const check = (before: string[], after: string[]) =>
    unexplainedListChange(before, after, getEntry, 't', PREFERRED_RULE);

  it('accepts a preferred reading moving ahead of a banded one', () => {
    expect(check([QIAO, KE], [KE, QIAO])).toEqual([]);
  });

  it('accepts a cross-reference-only entry losing its band precedence', () => {
    expect(check([JIN4, JIN3], [JIN3, JIN4])).toEqual([]);
  });

  it('rejects the preferred reading moving behind', () => {
    expect(check([KE, QIAO], [QIAO, KE])).not.toEqual([]);
  });

  it('rejects a cross-reference-only entry moving ahead', () => {
    expect(check([JIN3, JIN4], [JIN4, JIN3])).not.toEqual([]);
  });

  it('rejects a list that should have swapped and did not', () => {
    expect(check([QIAO, KE], [QIAO, KE])).not.toEqual([]);
    expect(check([JIN4, JIN3], [JIN4, JIN3])).not.toEqual([]);
  });

  it('rejects a swap neither of its clauses explains, including the band rule\'s own', () => {
    expect(check([KAN4, KAN1], [KAN1, KAN4])).not.toEqual([]);
    expect(check([GE3, GE4], [GE4, GE3])).not.toEqual([]);
  });

  it('rejects a swap across frequencies, and a lost id', () => {
    expect(check([KAN4, KE], [KE, KAN4])).not.toEqual([]);
    expect(check([QIAO, KE], [KE])).not.toEqual([]);
  });

  it('rejects a passage whose readings moved in a way the rule does not explain', () => {
    // The digests are honest — each is what re-sorting gives — so only the
    // pairwise check can catch it.
    const tokens = passageTokens(2_000);
    const wrong: OrderRule = { ...PREFERRED_RULE, after: lastTieBackwards };
    const before = sha256(JSON.stringify(reorderReadings(tokens, getEntry, wrong.before)));
    const after = sha256(JSON.stringify(reorderReadings(tokens, getEntry, wrong.after)));
    expect(before, 'the passage has no tie for the mutant to break').not.toBe(after);
    expect(unexplainedTokenDigest(tokens, getEntry, before, after, wrong)).not.toEqual([]);
    // …and the real rule over the same passage is clean.
    expect(
      unexplainedTokenDigest(
        tokens,
        getEntry,
        before,
        sha256(JSON.stringify(reorderReadings(tokens, getEntry, PREFERRED_RULE.after))),
        PREFERRED_RULE,
      ),
    ).toEqual([]);
  }, 60_000);
});
