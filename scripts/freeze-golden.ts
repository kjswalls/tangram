/**
 * Re-bless the golden fixtures after a change to the dictionary's reading
 * order — and refuse to, for any change that order does not explain.
 *
 * `data.md` D6 froze what the JSON implementation answered and then deleted it;
 * the generator that did the freezing is kept verbatim, unrunnable, in
 * `apps/app/tests/unit/dict/golden/README.md`. This is its runnable successor,
 * and it is narrower on purpose. **It regenerates only the fields whose value
 * depends on the order of a headword's readings**, from implementations that
 * still exist, and carries everything else forward untouched:
 *
 * | Field | Regenerated from |
 * |---|---|
 * | `search.json` `longPassage` | `scripts/dict-json.ts`'s `segment()` — the JSON DP, still alive as `pnpm data`'s input, so the digest stays a JSON-implementation answer |
 * | `retrieve.json` `mergedSearch`, `candidateEntries` | `packages/ai/retrieve.ts` over the SQLite store — the route's originals are deleted, and these two are the code the fixture exists to hold still |
 * | everything else | carried forward: the deleted `search()` answered it, and group keys, routing and paging do not depend on the order of readings inside a group |
 *
 * Every field that comes out different is then checked by
 * `scripts/golden-rebless.ts` against **one rule, `CURRENT_RULE`** — the
 * reading-order change being re-blessed and nothing broader: an id list may only
 * be reordered, and only as that rule allows; the passage digest must be
 * reproducible from today's tokens by re-sorting each token's readings the old
 * way. **Any other difference means nothing is written** and the script exits 1
 * with the list. That is the point of it: a bug introduced alongside a ranking
 * change would otherwise be blessed with it.
 *
 * On success it writes the two fixtures and appends a step to
 * `golden/rebless.json`, the record of every re-bless so far, which
 * `tests/unit/dict/golden-rebless.test.ts` re-proves.
 *
 * **The next reading-order change** freezes a copy of today's `compareEntries`
 * in `golden-rebless.ts`, writes a new `OrderRule` whose `before` is that copy,
 * and points `CURRENT_RULE` and `REASON` at it.
 *
 * Run: `pnpm golden` (`--check` reports without writing). It needs `pnpm data`,
 * and it refuses a dictionary whose entries differ from the fixtures'
 * provenance — an upstream data move is a different re-bless, and a human one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { candidateEntries, mergedSearch } from '../packages/ai/retrieve';
import { MANIFEST_FILE, type DictManifest } from '../apps/app/lib/dict/artifact';
import { nodeRunner } from '../apps/app/lib/dict/runners/node';
import { SqliteDictStore } from '../apps/app/lib/dict/sqlite-store';
import { dataDir, dirOf, workspaceRoot } from '../apps/app/lib/server/roots';
import type { Entry } from '../apps/app/lib/types';
import { getDict, getEntry, segment } from './dict-json';
import {
  canonical,
  differingPaths,
  getPath,
  PREFERRED_RULE,
  sha256,
  tokensInCurrentOrder,
  unexplainedListChange,
  unexplainedTokenDigest,
  type ReblessRecord,
  type ReblessStep,
} from './golden-rebless';

const ROOT = workspaceRoot(dirOf(import.meta.url));
export const SEARCH_FIXTURE = 'apps/app/tests/unit/dict/golden/search.json';
export const RETRIEVE_FIXTURE = 'apps/app/tests/unit/ai/golden/retrieve.json';
export const REBLESS_RECORD = 'apps/app/tests/unit/dict/golden/rebless.json';

/** The one reading-order change this script will re-bless. */
const CURRENT_RULE = PREFERRED_RULE;

const REASON =
  'compareEntries gained two tie-breaks (HANDOFF.md "Preferred readings"): a hand-kept list of ' +
  'preferred readings goes before the HSK band, and an entry whose every gloss is a cross-reference ' +
  'no longer has its band counted.';

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The writer — the original generator's, unchanged, so a carried-forward
// section is byte-identical and the diff shows only what moved.
// ---------------------------------------------------------------------------

function pretty(value: unknown, depth: number, indent = ''): string {
  if (depth === 0 || value === null || typeof value !== 'object') return JSON.stringify(value);
  const next = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => next + pretty(item, depth - 1, next)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  const body = entries
    .map(([key, item]) => `${next}${JSON.stringify(key)}: ${pretty(item, depth - 1, next)}`)
    .join(',\n');
  return `{\n${body}\n${indent}}`;
}

function render(sections: readonly (readonly [string, string])[]): string {
  const body = sections.map(([key, value]) => `  ${JSON.stringify(key)}: ${value}`).join(',\n');
  return `{\n${body}\n}\n`;
}

export function renderSearch(fixture: Json): string {
  return render([
    ['provenance', pretty(fixture.provenance, 2, '  ')],
    ['corpus', JSON.stringify(fixture.corpus)],
    ['hanzi', pretty(fixture.hanzi, 2, '  ')],
    ['pinyin', pretty(fixture.pinyin, 2, '  ')],
    ['gloss', pretty(fixture.gloss, 1, '  ')],
    ['routing', pretty(fixture.routing, 1, '  ')],
    ['paging', pretty(fixture.paging, 2, '  ')],
    ['longPassage', pretty(fixture.longPassage, 2, '  ')],
  ]);
}

export function renderRetrieve(fixture: Json): string {
  return render([
    ['provenance', pretty(fixture.provenance, 2, '  ')],
    ['mergedSearch', pretty(fixture.mergedSearch, 1, '  ')],
    ['candidateEntries', pretty(fixture.candidateEntries, 2, '  ')],
  ]);
}

// ---------------------------------------------------------------------------
// The regenerated fields
// ---------------------------------------------------------------------------

/** `gloss.test.ts`'s `longPassage`, byte for byte — the original generator's. */
export function longPassage(chars: number): string {
  const headwords = [...new Set(getDict().entries.map((entry) => entry.simp))].filter(
    (word) => [...word].length >= 2 && [...word].length <= 4,
  );
  let out = '';
  let i = 0;
  while ([...out].length < chars) {
    out += headwords[(i * 37) % headwords.length];
    i += 1;
  }
  return [...out].slice(0, chars).join('');
}

/** The passage's tokens, from the JSON segmenter. Exported for the proof test. */
export function passageTokens(chars: number): ReturnType<typeof segment>['tokens'] {
  return segment(longPassage(chars)).tokens;
}

const ids = (entries: readonly Entry[]): string[] => entries.map((entry) => entry.id);

function dictEntriesSha256(): string {
  return sha256(JSON.stringify(getDict().entries));
}

async function openStore(): Promise<SqliteDictStore> {
  const manifest = JSON.parse(
    readFileSync(resolve(dataDir(), MANIFEST_FILE), 'utf8'),
  ) as DictManifest;
  const store = new SqliteDictStore({
    connect: async () => nodeRunner(resolve(dataDir(), manifest.file)),
  });
  await store.open();
  return store;
}

function read(file: string): Json {
  return JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')) as Json;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const searchBefore = read(SEARCH_FIXTURE);
  const retrieveBefore = read(RETRIEVE_FIXTURE);

  const provenance = searchBefore.provenance as { dictEntriesSha256: string };
  if (provenance.dictEntriesSha256 !== dictEntriesSha256()) {
    process.stderr.write(
      'freeze-golden: data/dict.json is not the dictionary the fixtures were cut from.\n' +
        'This script re-blesses a change of reading ORDER over the same entries; an upstream\n' +
        'data move is a human re-bless (apps/app/tests/unit/dict/golden/README.md).\n',
    );
    process.exit(1);
  }

  const searchAfter = structuredClone(searchBefore);
  const retrieveAfter = structuredClone(retrieveBefore);

  const passage = longPassage(20_000);
  const tokens = segment(passage).tokens;
  searchAfter.longPassage = {
    chars: 20_000,
    textSha256: sha256(passage),
    tokenCount: tokens.length,
    tokensSha256: sha256(JSON.stringify(tokens)),
  };

  const store = await openStore();
  try {
    const merged: Record<string, string[]> = {};
    for (const query of Object.keys(retrieveBefore.mergedSearch as Json)) {
      merged[query] = ids(await mergedSearch(store, query));
    }
    retrieveAfter.mergedSearch = merged;
    const frozen = retrieveBefore.candidateEntries as { phrases: string[] }[];
    const candidates: { phrases: string[]; ids: string[] }[] = [];
    for (const { phrases } of frozen) {
      candidates.push({ phrases, ids: ids(await candidateEntries(store, phrases)) });
    }
    retrieveAfter.candidateEntries = candidates;
  } finally {
    await store.close();
  }

  // -------------------------------------------------------------------------
  // Explain every difference, or write nothing.
  // -------------------------------------------------------------------------
  const complaints: string[] = [];
  if (!tokensInCurrentOrder(tokens, getEntry)) {
    complaints.push('the segmenter’s readings are not in compareEntries order');
  }
  const changes: ReblessStep['changes'] = [];
  const pairs = [
    [SEARCH_FIXTURE, searchBefore, searchAfter],
    [RETRIEVE_FIXTURE, retrieveBefore, retrieveAfter],
  ] as const;
  for (const [file, before, after] of pairs) {
    for (const path of differingPaths(before, after)) {
      const label = `${file} ${JSON.stringify(path)}`;
      const was = getPath(before, path);
      const now = getPath(after, path);
      const isIds =
        (path[0] === 'mergedSearch' && path.length === 2) ||
        (path[0] === 'candidateEntries' && path.length === 3 && path[2] === 'ids');
      if (file === RETRIEVE_FIXTURE && isIds) {
        complaints.push(
          ...unexplainedListChange(was as string[], now as string[], getEntry, label, CURRENT_RULE),
        );
        changes.push({ file, path, kind: 'ids', before: was, after: now });
      } else if (
        file === SEARCH_FIXTURE &&
        canonical(path) === canonical(['longPassage', 'tokensSha256'])
      ) {
        complaints.push(
          ...unexplainedTokenDigest(tokens, getEntry, was as string, now as string, CURRENT_RULE).map(
            (complaint) => `${label}: ${complaint}`,
          ),
        );
        changes.push({ file, path, kind: 'tokenDigest', before: was, after: now });
      } else {
        complaints.push(`${label}: changed, and nothing about the reading order explains it`);
      }
    }
  }

  if (complaints.length > 0) {
    process.stderr.write(
      `freeze-golden: ${complaints.length} change(s) the ${CURRENT_RULE.name} rule does not explain — nothing written.\n` +
        `${complaints.map((line) => `  ${line}`).join('\n')}\n`,
    );
    process.exit(1);
  }
  if (changes.length === 0) {
    process.stdout.write('freeze-golden: the fixtures already match; nothing to re-bless\n');
    return;
  }

  for (const change of changes) {
    process.stdout.write(`  ${change.kind.padEnd(11)} ${change.file} ${JSON.stringify(change.path)}\n`);
  }
  if (check) {
    process.stdout.write(`freeze-golden --check: ${changes.length} change(s), all explained; nothing written\n`);
    return;
  }

  const record = read(REBLESS_RECORD) as unknown as ReblessRecord;
  record.steps.push({
    rule: CURRENT_RULE.name,
    reason: REASON,
    files: {
      [SEARCH_FIXTURE]: { beforeCanonicalSha256: sha256(canonical(searchBefore)) },
      [RETRIEVE_FIXTURE]: { beforeCanonicalSha256: sha256(canonical(retrieveBefore)) },
    },
    changes,
  });
  writeFileSync(resolve(ROOT, SEARCH_FIXTURE), renderSearch(searchAfter));
  writeFileSync(resolve(ROOT, RETRIEVE_FIXTURE), renderRetrieve(retrieveAfter));
  writeFileSync(resolve(ROOT, REBLESS_RECORD), `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(
    `freeze-golden: ${changes.length} change(s), every one explained by the ${CURRENT_RULE.name} rule; wrote both fixtures and appended to ${REBLESS_RECORD}\n`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) await main();
