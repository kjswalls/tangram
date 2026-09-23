// @vitest-environment node
/**
 * The golden fixtures were re-blessed once for a change of reading order, and
 * this re-proves, on every run, that the re-bless moved nothing else.
 *
 * `compareEntries` gained an HSK-band tie-break (HANDOFF.md "The default
 * reading"), which changed three frozen expectations. The fixtures cannot be
 * regenerated from the implementation that first answered them — `data.md` D6
 * deleted it — so `scripts/freeze-golden.ts` re-blessed them under a rule, and
 * wrote down what it changed in `golden/rebless.json`. Three things are proved
 * here from that record and the dictionary on disk:
 *
 *  1. **The record names every change.** Putting each `before` back into
 *     today's fixtures reproduces the fixtures as they were, to a canonical
 *     digest the generator took before writing. A change the record left out
 *     would make that digest differ.
 *  2. **Every change is the band rule and nothing else.** An id list is only
 *     reordered, and only between entries tied on frequency, variant and proper
 *     noun, with the lower band now first. The passage digest is reproduced
 *     byte for byte by re-sorting today's readings the old way.
 *  3. **The checker is not vacuous.** It rejects a swap across frequencies, a
 *     swap the wrong way round, a swap the rule demanded and the list did not
 *     make, a lost id and a moved token.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { workspaceRoot, dirOf } from '@/lib/server/roots';
import {
  canonical,
  compareEntriesBeforeBand,
  getPath,
  reorderReadings,
  setPath,
  sha256,
  unexplainedListChange,
  unexplainedTokenDigest,
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

describe('the band tie-break re-bless of the golden fixtures', () => {
  it('was cut from the dictionary on disk', () => {
    expect(goldenIsFresh(), STALE_HINT).toBe(true);
  });

  it('records every change it made, and each one is in the fixture now', () => {
    const files = Object.keys(rebless.files);
    expect(files.length).toBe(2);
    expect(rebless.changes.length).toBeGreaterThan(0);
    for (const file of files) {
      const now = fixture(file);
      const restored = structuredClone(now);
      for (const change of rebless.changes.filter((one) => one.file === file)) {
        expect(getPath(now, change.path), `${file} ${JSON.stringify(change.path)}`).toEqual(
          change.after,
        );
        setPath(restored, change.path, change.before);
      }
      expect(sha256(canonical(restored)), `${file}: a change the record does not name`).toBe(
        rebless.files[file].beforeCanonicalSha256,
      );
    }
  });

  it('changed id lists only where the rule says, and only by reordering', () => {
    const lists = rebless.changes.filter((change) => change.kind === 'ids');
    expect(lists.length).toBeGreaterThan(0);
    for (const change of lists) {
      const label = `${change.file} ${JSON.stringify(change.path)}`;
      expect(
        unexplainedListChange(
          change.before as string[],
          change.after as string[],
          getEntry,
          label,
        ),
      ).toEqual([]);
      expect(change.after, `${label}: nothing actually moved`).not.toEqual(change.before);
    }
  });

  it('changed the passage digest only by the order of readings inside a token', () => {
    const digests = rebless.changes.filter((change) => change.kind === 'tokenDigest');
    expect(digests.length).toBe(1);
    const tokens = passageTokens(20_000);
    expect(
      unexplainedTokenDigest(
        tokens,
        getEntry,
        digests[0].before as string,
        digests[0].after as string,
      ),
    ).toEqual([]);
  }, 120_000);
});

describe('the checker behind it', () => {
  // 个: gè (band 1) and gě (no band) tie on every earlier key — the swap the rule
  // licenses. 我 is a different frequency entirely.
  const GE3 = '個|个[ge3]';
  const GE4 = '個|个[ge4]';
  const WO = '我|我[wo3]';

  it('accepts the swap the rule licenses', () => {
    expect(unexplainedListChange([WO, GE3, GE4], [WO, GE4, GE3], getEntry, 't')).toEqual([]);
  });

  it('rejects the same swap made the other way', () => {
    expect(unexplainedListChange([WO, GE4, GE3], [WO, GE3, GE4], getEntry, 't')).not.toEqual([]);
  });

  it('rejects a list that should have swapped and did not', () => {
    expect(unexplainedListChange([WO, GE3, GE4], [WO, GE3, GE4], getEntry, 't')).not.toEqual([]);
  });

  it('rejects a swap across frequencies', () => {
    expect(unexplainedListChange([WO, GE4], [GE4, WO], getEntry, 't')).not.toEqual([]);
  });

  it('rejects a lost, gained or duplicated id', () => {
    expect(unexplainedListChange([WO, GE3, GE4], [WO, GE4], getEntry, 't')).not.toEqual([]);
    expect(unexplainedListChange([WO, GE4], [WO, GE4, GE3], getEntry, 't')).not.toEqual([]);
    expect(unexplainedListChange([WO, GE4], [WO, GE4, GE4], getEntry, 't')).not.toEqual([]);
  });

  it('rejects a token change that is not a reordering of readings', () => {
    const tokens = passageTokens(400);
    const digest = sha256(JSON.stringify(tokens));
    const moved = tokens.map((token, i) => (i === 3 ? { ...token, end: token.end + 1 } : token));
    expect(unexplainedTokenDigest(moved, getEntry, digest, sha256(JSON.stringify(moved)))).not.toEqual(
      [],
    );
    // …and accepts the same tokens unmoved, so the rejection above is the move.
    const before = sha256(
      JSON.stringify(reorderReadings(tokens, getEntry, compareEntriesBeforeBand)),
    );
    expect(unexplainedTokenDigest(tokens, getEntry, before, digest)).toEqual([]);
  }, 60_000);
});
