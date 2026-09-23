# The golden fixtures — what the JSON dictionary answered before D6 deleted it

`docs/plans/data.md` **D6** retires the server dictionary. Its first instruction is not a deletion:

> **One thing must happen before the first deletion.** D2's and D3's strongest tests are
> *differential*: they compare the store against the JSON index in the same process. This phase
> deletes that oracle. So the first commit of D6 **freezes those comparisons into golden fixtures**
> generated from the JSON implementation while it still exists […] with the generator script kept
> beside them and marked unrunnable after this phase. A build session that deletes `LazyDictIndex`
> first will find the tests pass because there is nothing left to disagree with.

These two files are that freeze:

| File | Read by |
|---|---|
| `apps/app/tests/unit/dict/golden/search.json` | `tests/unit/dict/store.test.ts`, `tests/unit/dict/gloss.test.ts` |
| `apps/app/tests/unit/ai/golden/retrieve.json` | `tests/unit/ai/retrieve.test.ts` |

## What is frozen, and what deliberately is not

Only the answers the **deleted algorithms** decided:

- `lib/dict/search.ts`'s router (`route`), its section allocation (`sections`) and its group
  ordering — for D2 criterion 4's hanzi and pinyin query lists, for D3 criterion 4's 200-query
  English corpus, for D3's six `isGlossToken` routing cases, and for D3 criterion 5's two paging
  walks;
- `lib/dict/segment.ts`'s DP, as a digest of the token array for the 20,000-character passage;
- `app/api/ask/route.ts`'s `mergedSearch` and `candidateEntries` — D3 criterion 9's oracle, which
  lived on the route and dies with it.

**The primitives underneath are not frozen**, because they do not need to be: entries by id, a whole
HSK band in its order, the readings of a headword, the `bySimp`/`byTrad`/`byHsk`/`byPinyin*`/`byGloss`
groupings are all re-derivable from `data/dict.json` using functions that survive D6 —
`lib/dict/rank.ts`'s `compareEntries` and `glossTokens`, `lib/dict/pinyin.ts`'s `readingKeys` and
`normalizePinyin`. That re-derivation is [`../json-oracle.ts`](../json-oracle.ts), and it is a
**better** oracle than a fixture would be: it is computed from the raw generated data at test time,
so it keeps working when `pnpm data` pulls a newer HSK list or jieba frequency table. A fixture
cannot do that. This is the one place D6's instruction was read as a purpose rather than a recipe,
and the split is recorded in `HANDOFF.md`.

## Large lists are frozen as count + head + digest

`hanziKeys` and `pinyinKeys` are `{count, head, sha256}`. The digest is over the whole list **in
order**, so a lost key, a reordered pair or a silently lowered cap changes it; `head` is the first
twenty keys, so the failure is readable rather than one hex string against another. The gloss corpus
and the paging walks are frozen in full, because their assertion is set **containment** (nothing the
JSON implementation returned may be missing from the store's answer) and a digest cannot answer that.

## Staleness is a loud failure, on purpose

`provenance.dictEntriesSha256` is a sha256 over `data/dict.json`'s **entries** — not over the
file, which carries a `meta.builtAt` timestamp and would therefore report every rebuild as a data
change. `pnpm data`
downloads the HSK list, the jieba frequencies and Make Me a Hanzi from `master` branches, so the data
*can* move under a fixture (CC-CEDICT itself is pinned, at `cedict-json@1.3.20251213`). When it does,
the suites say so by name and stop — they do not skip. Re-blessing is a human judgement now that the
JSON implementation is gone: read the diff, decide whether the new answers are right, and record the
decision. That is the normal golden-file contract, and it is the cost of D6.

## Re-blessed once, for the reading order — 2026-09-23

`compareEntries` gained an HSK-band tie-break before the id (`lib/dict/rank.ts`; HANDOFF.md "The
default reading"). That reorders the readings of a headword wherever they tie on frequency, variant
and proper noun, and three frozen expectations held a reading order:

| Fixture | Field | What moved |
|---|---|---|
| `search.json` | `longPassage.tokensSha256` | the order of readings inside some of the 8,047 tokens |
| `retrieve.json` | `candidateEntries[1].ids` | 多少 duōshao (HSK 1) now before duōshǎo |
| `retrieve.json` | `candidateEntries[4].ids` | 个 gè (HSK 1) now before gě |

Nothing else moved: group keys, routing, paging and `mergedSearch` do not depend on the order of
readings inside a group, and the provenance digest is over `dict.json`'s entries, which did not
change. **The deleted implementation could not re-answer, so the re-bless was done under a rule
rather than by judgement:**

- `scripts/freeze-golden.ts` (`pnpm golden`, `--check` for a dry run) regenerates only the fields
  that depend on reading order — the passage from `scripts/dict-json.ts`'s JSON segmenter, the two
  retrieve lists from `packages/ai/retrieve.ts` over the store — and carries every other field
  forward byte for byte. It **writes nothing** if any field differs in a way
  `scripts/golden-rebless.ts` cannot explain: an id list may only be reordered, and only between
  entries tied on frequency, variant and proper noun with the lower band now first; the passage
  digest must be reproduced exactly by re-sorting today's readings the old way.
- `golden/rebless.json` records each change, before and after, and a canonical digest of each
  fixture as it was. `tests/unit/dict/golden-rebless.test.ts` re-proves the whole thing on every
  run, including that putting the `before` values back reproduces the old fixtures — so the record
  cannot have left a change out — and that the checker rejects a swap it should.

An upstream data move is still a human re-bless: `freeze-golden.ts` refuses a `dict.json` whose
entries differ from the provenance.

## Re-blessed a second time, for preferred readings — 2026-09-23

`compareEntries` gained two more tie-breaks (HANDOFF.md "Preferred readings"): a hand-kept list of
preferred first readings (`lib/dict/preferred-readings.ts`) goes before the HSK band, and the band of
an entry whose every gloss is a cross-reference ("see …", "used in …", "variant of …") no longer
counts. **One frozen expectation moved**, `search.json` `longPassage.tokensSha256`; neither retrieve
list holds a headword either rule touches.

The mechanism is the same, with one rule per re-bless. `scripts/golden-rebless.ts` names each as an
`OrderRule` (`band`, then `preferred-and-cross-reference`), and `freeze-golden.ts` re-blesses only
under the current one. `golden/rebless.json` is now a chain of steps, oldest first; the first step is
the band re-bless's record, unchanged. The test undoes the steps newest first and checks that each
lands on the digest its step recorded, and it re-proves every step under that step's own rule.

The passage proof is also stricter than it was. Re-sorting today's tokens the old and new ways and
comparing digests proves that only the order of readings moved, but not *why*: a `compareEntries`
that sorted by id backwards would reproduce its own digest. Each token whose readings moved now also
goes through the pairwise check that the id lists go through. The test runs exactly that mutant and
requires it to be rejected.

## The generator, kept beside the fixtures and unrunnable

It was `scripts/freeze-golden.ts`, run once as

```
TANGRAM_DATA_DIR="$PWD/data" tsx scripts/freeze-golden.ts
```

and **deleted in the commit that deleted the five modules it imports** — `app/api/ask/route.ts`'s
two exports, `lib/dict/load.ts`, `lib/dict/search.ts`'s `search()` and `lib/dict/segment.ts`'s
`segment()`. Keeping the `.ts` file on disk would only mean a tree that does not typecheck, so it is
kept here instead, verbatim. That is what "marked unrunnable" has to mean in a repository with no
build step that could exclude it.

<details>
<summary><code>scripts/freeze-golden.ts</code>, as it was run</summary>

```ts
/**
 * Freeze the JSON implementation's answers into golden fixtures — `data.md` D6's
 * first job, and the only one that has to happen before a single deletion.
 *
 * D2's and D3's strongest tests are **differential**: they ask "does the SQLite
 * store answer what `lib/dict/index.ts` answers", in one process, against the
 * same data. D6 deletes that oracle. A build session that deletes
 * `LazyDictIndex` first finds every one of those tests passing, because there is
 * nothing left to disagree with.
 *
 * So this script runs while both implementations are alive and writes down what
 * the JSON one says. **It is deleted in the commit that deletes the modules it
 * imports**, and its source is kept verbatim in
 * `apps/app/tests/unit/dict/golden/README.md` — which is what `data.md` D6 means
 * by "the generator script kept beside them and marked unrunnable after this
 * phase". Keeping a `.ts` that imports five deleted modules would only mean a
 * tree that does not typecheck.
 *
 * **What is frozen here and what is NOT.** Only the answers that the deleted
 * *algorithms* decided: `search()`'s router, its section allocation and its group
 * ordering; the DP in `segment()`; and `app/api/ask/route.ts`'s retrieval. The
 * primitives underneath them — entries by id, a whole HSK band in order, the
 * readings of a headword, the posting lists — are NOT frozen, because they are
 * re-derivable from `data/dict.json` with functions that survive D6 (`rank.ts`'s
 * `compareEntries` and `glossTokens`, `pinyin.ts`'s `readingKeys`). That
 * re-derivation is `tests/unit/dict/json-oracle.ts`, and it is a better oracle
 * than a fixture: it keeps working when the upstream data moves under us, which
 * a fixture cannot.
 *
 * Run: `TANGRAM_DATA_DIR="$PWD/data" tsx scripts/freeze-golden.ts`
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { candidateEntries, mergedSearch } from '../apps/app/app/api/ask/route';
import { dataDir, getDict } from '../apps/app/lib/dict/load';
import { glossTokens } from '../apps/app/lib/dict/rank';
import { search } from '../apps/app/lib/dict/search';
import { segment } from '../apps/app/lib/dict/segment';
import { dirOf, workspaceRoot } from '../apps/app/lib/server/roots';
import type { SearchResult } from '../apps/app/lib/dict/search';
import type { Entry } from '../apps/app/lib/types';

const OUT_DICT = resolve(workspaceRoot(dirOf(import.meta.url)), 'apps/app/tests/unit/dict/golden');
const OUT_AI = resolve(workspaceRoot(dirOf(import.meta.url)), 'apps/app/tests/unit/ai/golden');

/** A page big enough that no section is cut by paging. */
const WHOLE = { limit: 100_000 };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * A list frozen in a form that stays small and still cannot pass by accident.
 *
 * The digest is over the list in order, so any drift — a lost key, a reordered
 * pair, a silently lowered cap — changes it. The `head` is there so the failure
 * is readable: a diff of the first twenty keys usually says which end moved.
 */
interface FrozenList {
  count: number;
  head: string[];
  sha256: string;
}

const HEAD = 20;

function freezeList(values: readonly string[]): FrozenList {
  return { count: values.length, head: values.slice(0, HEAD), sha256: sha256(values.join('\n')) };
}

/**
 * Pretty-print two levels deep and inline everything below.
 *
 * `JSON.stringify(x, null, 1)` puts every string of every posting list on its
 * own line and turns a 394 KB fixture into a 1 MB one; no indentation at all
 * makes it one unreviewable line. Two levels gives one line per query, which is
 * the granularity a diff of this file is read at.
 */
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

/** `{ "key": <value>, … }` with one top-level key per line. */
function writeJson(path: string, sections: readonly (readonly [string, string])[]): void {
  const body = sections.map(([key, value]) => `  ${JSON.stringify(key)}: ${value}`).join(',\n');
  writeFileSync(path, `{\n${body}\n}\n`);
}

function keysOf(result: SearchResult, source: string): string[] {
  return result.sections
    .filter((part) => part.source === source)
    .flatMap((part) => part.groups.map((group) => group.key));
}

// ---------------------------------------------------------------------------
// The query lists. Copied from the suites that will read the fixtures back, so
// a query added there without a fixture is a missing key rather than a silent
// hole.
// ---------------------------------------------------------------------------

const HANZI_QUERIES = [
  '打算', '打', '了', '學習', '学习', '中', '我',
  '𩽾', '𧿹', '龘', '爸爸', '中华人民共和国',
];

const PINYIN_QUERIES = [
  'dasuan', 'da3suan4', 'dǎsuàn', 'da3 suan4', 'DaSuan', 'wǒmen', 'wo3men',
  'women', 'xian', "xi1'an1", 'lu:4', 'lv4', 'lǜ', 'nu:3', 'da', 'dasu',
  'yi', 'hé', 'shi', 'ni3hao3',
];

const PHRASES = [
  'to plan', 'to eat', 'old man', 'young woman', 'to go to', 'one hundred',
  'water and fire', 'big brother', 'to be able to', 'not yet', 'a lot of',
  'to look at', 'to make a', 'in front of', 'point of view', 'to take care of',
  'to be born', 'to get up', 'south of the', 'to come back',
];

const ROUTING = ['sun', 'can', 'women', 'shi', 'he', 'ta'];

const ASK_QUERIES = [
  'how do I say I am just browsing',
  'what does this mean',
  'how do you say thank you in Chinese',
  'I would like to order the beef noodles',
  'is this seat taken',
  'where is the nearest subway station',
  'plan', 'water', 'tomorrow', 'expensive', 'beautiful',
  '打算', '我打算明天去北京', '学习', '中华人民共和国', '你好吗', '这个多少钱',
  'how do I say 打算', 'what is 学习', 'the difference between 二 and 两',
  'zzzqqqnothing', '',
];

const ASK_PHRASES: string[][] = [
  ['我随便看看'],
  ['我打算明天去北京', '这个多少钱'],
  ['谢谢', '不客气', '对不起'],
  ['学习中文很有意思'],
  Array.from({ length: 12 }, (_, i) => `第${i}个句子测试`),
  ['   ', ''],
  ['a'.repeat(80)],
  ['我'.repeat(60)],
];

/** `gloss.test.ts`'s corpus, byte for byte. */
function glossCorpus(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of getDict().entries) {
    if (entry.isVariant) continue;
    for (const gloss of entry.glosses) {
      for (const token of glossTokens(gloss)) {
        if (token.length < 3 || seen.has(token)) continue;
        seen.add(token);
        out.push(token);
        if (out.length >= 180) return [...out, ...PHRASES];
      }
    }
  }
  return [...out, ...PHRASES];
}

/** `gloss.test.ts`'s `longPassage`, byte for byte. */
function longPassage(chars: number): string {
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

function pageAll(query: string): { keys: string[]; total: number; pages: number } {
  const keys: string[] = [];
  let total = -1;
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = search(query, cursor ? { cursor } : {});
    keys.push(...page.groups.map((group) => group.key));
    total = page.total;
    pages += 1;
    if (!page.nextCursor || pages >= 200) break;
    cursor = page.nextCursor;
  }
  return { keys, total, pages };
}

const ids = (entries: readonly Entry[]): string[] => entries.map((entry) => entry.id);

// ---------------------------------------------------------------------------

function provenance(): Record<string, unknown> {
  const file = resolve(dataDir(), 'dict.json');
  const dict = getDict();
  return {
    dictVersion: dict.meta.version,
    entryCount: dict.entries.length,
    dictEntriesSha256: sha256(JSON.stringify(dict.entries)),
    frozenBy: 'scripts/freeze-golden.ts (data.md D6; see README.md)',
  };
}

function main(): void {
  mkdirSync(OUT_DICT, { recursive: true });
  mkdirSync(OUT_AI, { recursive: true });

  const hanzi: Record<string, { route: string; sections: string[]; hanziKeys: FrozenList }> = {};
  for (const query of HANZI_QUERIES) {
    const result = search(query, WHOLE);
    hanzi[query] = {
      route: result.route,
      sections: result.sections.map((part) => part.source),
      hanziKeys: freezeList(keysOf(result, 'hanzi')),
    };
  }

  const pinyin: Record<string, { route: string; sections: string[]; pinyinKeys: FrozenList }> = {};
  for (const query of PINYIN_QUERIES) {
    const result = search(query, WHOLE);
    pinyin[query] = {
      route: result.route,
      sections: result.sections.map((part) => part.source),
      pinyinKeys: freezeList(keysOf(result, 'pinyin')),
    };
  }

  const corpus = glossCorpus();
  const gloss: Record<string, string[]> = {};
  for (const query of corpus) gloss[query] = keysOf(search(query, WHOLE), 'english');

  const routing: Record<string, string[]> = {};
  for (const query of ROUTING) {
    routing[query] = search(query, { limit: 50 }).sections.map((part) => part.source);
  }

  const paging: Record<string, { total: number; pages: number; keys: string[] }> = {};
  for (const query of ['da', 'to']) {
    const walked = pageAll(query);
    paging[query] = { total: walked.total, pages: walked.pages, keys: walked.keys };
  }

  const passage = longPassage(20_000);
  const passageTokens = segment(passage).tokens;

  const stamp = pretty(provenance(), 2, '  ');

  writeJson(resolve(OUT_DICT, 'search.json'), [
    ['provenance', stamp],
    ['corpus', JSON.stringify(corpus)],
    ['hanzi', pretty(hanzi, 2, '  ')],
    ['pinyin', pretty(pinyin, 2, '  ')],
    ['gloss', pretty(gloss, 1, '  ')],
    ['routing', pretty(routing, 1, '  ')],
    ['paging', pretty(paging, 2, '  ')],
    [
      'longPassage',
      pretty(
        {
          chars: 20_000,
          textSha256: sha256(passage),
          tokenCount: passageTokens.length,
          tokensSha256: sha256(JSON.stringify(passageTokens)),
        },
        2,
        '  ',
      ),
    ],
  ]);

  const merged: Record<string, string[]> = {};
  for (const query of ASK_QUERIES) merged[query] = ids(mergedSearch(query));

  const candidates = ASK_PHRASES.map((phrases) => ({
    phrases,
    ids: ids(candidateEntries(phrases)),
  }));

  writeJson(resolve(OUT_AI, 'retrieve.json'), [
    ['provenance', stamp],
    ['mergedSearch', pretty(merged, 1, '  ')],
    ['candidateEntries', pretty(candidates, 2, '  ')],
  ]);

  process.stdout.write(
    `froze ${HANZI_QUERIES.length} hanzi, ${PINYIN_QUERIES.length} pinyin, ${corpus.length} gloss, ` +
      `2 paging walks, ${ASK_QUERIES.length} ask queries and ${candidates.length} phrase sets\n`,
  );
}

main();
```

</details>
