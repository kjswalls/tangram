# Build plan — dictionary and data layer

**Owner document:** [docs/STACK.md](../STACK.md) §2.5 is the decision this plan executes. Read
STACK.md first; this plan cites it rather than re-arguing it. Where a number below is marked
*measured 2026-09-13 (this plan)*, it was produced by a throwaway script in this container against
the real generated `data/dict.json` while writing this document, and it **supersedes the audit
figure it sits next to**, because it was measured against the schema specified here rather than
against the audit's own sketch.

Two facts frame everything and are not repeated: **there are no users and no data** — nothing here
is a migration plan — and the developer is solo, working with AI assistance.

---

## 1. Goal

The dictionary stops being a 35 MB JSON file parsed into a server's heap and becomes one prebuilt,
read-only SQLite file that every platform queries in place. When this is done, `pnpm data` emits
`dict-<schema>-<cedict>.sqlite` plus `decomp.json`; a `DictStore` interface answers every lookup,
search, segmentation and decomposition question the app has, backed by `sqlite-wasm` on OPFS in the
browser and by the Capacitor SQLite plugin on phones; and `app/api/dict/*` is deleted, because there
is no longer a server in the lookup path at all.

## 2. Scope boundaries

**This plan covers**

- The build step: what `pnpm data` emits, the SQLite schema and indexes, the derived pinyin key
  columns, the gloss FTS5 table, the `words` table for segmentation, the character tables, the
  `meta` table, versioning, naming, and the verification script that proves the file.
- The `DictStore` interface, the `SqlRunner` platform seam under it, and both implementations.
- Porting the query layer off the server: `lib/dict/pinyin.ts`, `search.ts`, `segment.ts`,
  `index.ts`, `decomp.ts`, `load.ts`, `client.ts`.
- Delivery of the artifact per platform (bundled vs downloaded), the first-run states, and the
  licence boundary between `dict.sqlite` and `decomp.json`.
- Retiring the five `app/api/dict/*` routes and the client-side pieces that let the three
  model-backed routes stop reading the dictionary.

**This plan does NOT cover** — named by the sibling plan that owns it:

| Not here | Owner |
|---|---|
| The Vite/React Router shell, PWA install, the web host and how the `.sqlite` is served | `docs/plans/web.md` |
| Lookup, reader, practice and library UI; the per-character ruby reader; the banner components that render `DictStore.status` | `docs/plans/core.md` |
| The Capacitor iOS project, `copyFromAssets` wiring into the Xcode build, App Store packaging | `docs/plans/ios.md` |
| The Capacitor Android project, asset packaging, Play requirements | `docs/plans/android.md` |
| Accounts, sync, the AI proxy, the new `POST /api/ask` wire contract, key custody | `docs/plans/backend.md` |
| The learner's own data (cards, reviews, lists) — `lib/db/**` and the Dexie repository | `docs/plans/core.md` |
| Astro static per-word pages (STACK §5.7) | `docs/plans/web.md` |

The seam between this plan and `ios.md`/`android.md` is exact: **this plan owns the file and the
`SqlRunner` implementation that opens it; those plans own getting the file into the app package and
the native project that runs it.** The seam with `backend.md` is also exact: this plan makes the
client able to retrieve entries and validate grounding locally; `backend.md` decides what goes on
the wire.

## 3. What exists today

Everything below was read in the repo on this branch.

**The generator.** `scripts/build-data.ts` (453 lines) downloads HSK 3.0, the jieba frequency list
and Make Me a Hanzi, reads CC-CEDICT out of the `cedict-json@1.3.20251213` npm package, and writes
three files into `data/` (gitignored): `dict.json` (35.1 MB, 124,188 entries), `decomp.json`
(0.92 MB) and `COPYING-makemeahanzi`. `data/ATTRIBUTION.md` is committed and rendered in
`/settings`. It derives `pinyinMarked` with `lib/dict/pinyin.ts`, lifts `CL:` references into
`classifiers[]`, joins HSK bands onto entry ids, and attaches jieba `freq`/`freqRank`.

**The runtime.** `lib/dict/load.ts` reads `data/*.json` with `node:fs` and memoises on `globalThis`;
it throws `DictDataMissingError`, which every route turns into
`503 {error:'dict-data-missing', hint:'run pnpm data'}`. `lib/dict/index.ts` builds seven indexes
lazily inside a `LazyDictIndex` class (`entries`, `bySimp`, `byTrad`, `byPinyinToneless`,
`byPinyinToned`, `byGloss`, `byHsk`) and exposes `getEntries`, `hskBand`, `readingCount`,
`exactIds`, `prefixIds`, `glossTokens`, `stemToken`, `parseIdList`. `lib/dict/search.ts` (587 lines)
holds the router, the `glossTier` ranking, headword grouping, section allocation and cursor paging.
`lib/dict/segment.ts` (218 lines) holds the jieba-style max-probability DP. `lib/dict/pinyin.ts`
(395 lines) holds `toMarked`, `normalizePinyin` and `readingKeys`. `lib/dict/decomp.ts` reads
`decomp.json`. `lib/dict/client.ts` holds the typed fetchers and `DictRequestError`.

**The routes.** There are **five** under `app/api/dict/`, not six as sometimes stated:
`entries/route.ts`, `hsk/route.ts`, `search/route.ts`, `segment/route.ts`, `decomp/route.ts`. All
five set `dynamic = 'force-dynamic'` and are listed in `next.config.ts`'s
`outputFileTracingIncludes`. A sixth dictionary-reading route exists but is not a `dict` route:
`/api/ask`. Do not go looking for a `/api/dict/*` route that is not in that list.

**Three more routes read the dictionary in-process** and are the reason this is not purely a client
change: `app/api/ask/route.ts` calls `getDictIndex()`, `segment()`, `getEntry()` and
`readingCount()`; `app/api/examples/route.ts` does the same; `app/api/recall/route.ts` is traced for
`./data/**` too. `app/api/ask/route.ts:177` `mergedSearch()` and `:198` `candidateEntries()` are the
retrieval step that would move to the client.

**Grounding is already injectable.** `lib/ai/ground.ts:403` defines `GroundContext` as
`{retrieved, segment, entry?, readings?}` — four injected values, no import of `lib/dict`. That is
what makes client-side grounding validation possible without touching `ground.ts`. One catch, worth
knowing before it is discovered: `segment` there is **synchronous**, `(text: string) => Token[]`,
and a `DictStore` is async. See §5.7.

**Consumers of `lib/dict/client.ts`** (these are what `core.md` must re-point):
`components/lookup/lookup-view.tsx`, `components/lookup/entry-detail.tsx`,
`components/lookup/ask-panel.tsx`, `components/reader/reader-lookup.tsx`,
`components/review/example-sentences.tsx`, `lib/stores/reader.ts`, `lib/lists/entry-source.ts`.

**Tests.** `tests/unit/dict/{index,pinyin,search,segment,routes}.test.ts` assert against the real
generated data via `tests/unit/dict/data-required.ts`. `tests/unit/server/cold-start.test.ts` is
load-bearing for this plan in a way its name hides: it proves `readingKeys` and `normalizePinyin`
agree on **every** reading in the built dictionary, and that `glossTokens` agrees with its slower
predecessor on every gloss. Those two properties are exactly what the build step must preserve.
`tests/e2e/p1/dict-api.spec.ts` hits the routes over HTTP.

**The container.** Node **22.22.2**, whose built-in `node:sqlite` module wraps SQLite **3.51.2**
with FTS5 compiled in (`porter`, `unicode61`, `detail=none`, `tokenchars` all verified working) —
*measured 2026-09-13 (this plan)*. There is no `sqlite3` CLI and no `brotli` binary; `node:zlib`
provides brotli. React Router 8 already requires Node ≥ 22.22 (STACK §6), so the build step needs
**no new dependency at all**.

## 4. Dependencies

**Before this plan starts:**

1. **CLAUDE.md must be rewritten** (STACK §7). It is auto-loaded project instructions and currently
   states a Next-shaped command set and a frozen-file list that this plan contradicts. In
   particular it freezes `lib/types.ts`, which Phase D1 needs to touch. Do this first, as its own
   commit, or every phase below fights the instructions.
2. **The repository/workspace layout must be decided** (STACK §7): one pnpm workspace or three
   repos. This plan assumes one workspace with `pnpm data` at the root writing to `data/`, and each
   deployable's build copying from there. If that is wrong, only Phase D1's output paths change.
3. Nothing else. Phases D1–D4 run entirely in this Linux container with no hardware.

**Sibling-plan gates:**

| Phase | Needs |
|---|---|
| D1, D2, D3 | Nothing. They are pure TypeScript against Node's own SQLite. |
| D4 (web store) | `web.md` must have reached the point where a Vite build exists and can serve a static asset and run a worker. It does **not** need the shell rewritten. |
| D5 (native store) | `ios.md` / `android.md` must have a Capacitor project that builds and installs on a device, and the hardware in STACK §4's preconditions table must exist. |
| D6 (retire the routes) | `core.md` must have re-pointed every consumer in §3 at `DictStore`, and `backend.md` must have settled the `/api/ask` contract (STACK §5.5). |

**What other plans may start against, and when.** The `DictStore` and `SqlRunner` interfaces and the
SQL schema are settle-first surfaces (STACK §7). They land as the **first commit of D1** and are
frozen from then on. `core.md` may code against `DictStore` from that commit, with the in-Node
implementation from D2/D3 as its test double, long before D4 or D5 exist.

---

## 5. Phases

Six phases. D1–D3 are container-only and should be done first and in order; D4 and D5 are
independent of each other; D6 is the cleanup that can only run last.

### D1 — The artifact: `pnpm data` emits one SQLite file

**What it builds.** The schema, the builder, the verifier, and the size/latency report. No app code
changes. At the end of this phase `data/` holds a `.sqlite` file that provably contains the same
dictionary `data/dict.json` does.

**Files.**

- `lib/dict/schema.sql` — new. The canonical DDL, read by the builder at build time and by the
  verifier. One file so there is exactly one copy of the schema.
- `lib/dict/artifact.ts` — new. Artifact naming, `SCHEMA_VERSION`, the `application_id` magic, the
  manifest shape. Imported by the builder, the verifier and both stores.
- `scripts/build-data.ts` — extended: after building the in-memory `DictEntry[]` it now also writes
  the SQLite file and the manifest. Keep writing `dict.json` in this phase; D6 decides its fate.
- `scripts/verify-data.ts` — new, wired as `pnpm data:verify`.
- `lib/types.ts` — touched only if `Entry` needs no change (it should not; the SQLite row maps onto
  the existing `Entry` exactly). Confirm rather than assume.
- `data/ATTRIBUTION.md` — the modification notice now covers a second derived artifact.

**The schema, stated explicitly.** This is the settle-first surface; it does not change after D1
without a `SCHEMA_VERSION` bump.

```sql
PRAGMA page_size   = 4096;      -- what the dictionary audit measured at
PRAGMA encoding    = 'UTF-8';
PRAGMA user_version = 1;        -- SCHEMA_VERSION; bumped on any change below
PRAGMA application_id = 0x54474D31;  -- 'TGM1'; a wrong file is detected, not misread

-- One row per CC-CEDICT headword-reading pair. 124,188 rows.
-- rowid is assigned in `compareEntries` order (freq DESC, isVariant ASC, properNoun ASC,
-- id ASC) — see "rowid is the sort key" below.
CREATE TABLE entries (
  rowid          INTEGER PRIMARY KEY,
  id             TEXT    NOT NULL,   -- 'trad|simp[pinyinNum]'
  simp           TEXT    NOT NULL,
  trad           TEXT    NOT NULL,
  pinyin_num     TEXT    NOT NULL,
  pinyin_marked  TEXT    NOT NULL,
  glosses        TEXT    NOT NULL,   -- JSON array; order is the sense index the AI cites
  classifiers    TEXT,               -- JSON array, NULL when empty
  py_toneless    TEXT,               -- 'dasuan';  NULL for xx5 readings
  py_toned       TEXT,               -- 'da3suan4'; NULL for xx5 readings
  proper_noun    INTEGER NOT NULL,
  is_variant     INTEGER NOT NULL,
  surname        INTEGER NOT NULL,
  variant_of     TEXT,
  pos            TEXT,
  hsk_band       INTEGER,
  freq_rank      INTEGER,
  freq           INTEGER
);
CREATE UNIQUE INDEX entries_id     ON entries(id);
CREATE INDEX        entries_simp   ON entries(simp);
CREATE INDEX        entries_trad   ON entries(trad);
CREATE INDEX        entries_py_tl  ON entries(py_toneless);
CREATE INDEX        entries_py_td  ON entries(py_toned);
CREATE INDEX        entries_hsk    ON entries(hsk_band, freq_rank);

-- English glosses. Contentless: the text is never read back, only matched.
-- The indexed text is the output of glossTokens() — already stemmed and deduped per
-- gloss — so unicode61 acts as a whitespace splitter and the build-time and query-time
-- stemmers cannot drift. `tokenchars ''''` keeps the apostrophe inside a token.
-- is_variant rows are NOT indexed, exactly as index.ts skips them today.
CREATE VIRTUAL TABLE gloss_fts USING fts5(
  text,
  content='',
  tokenize="unicode61 tokenchars ''''",
  detail=none
);

-- The segmentation DAG. 242,087 rows (120,448 simp + 121,639 trad).
-- freq is headwordFreq(): the freq of the entry that sorts first for this headword,
-- defaulting to 1. Computed in TS at build time, not by SQL — see the acceptance criteria.
CREATE TABLE words (
  script TEXT    NOT NULL,   -- 'simp' | 'trad'
  word   TEXT    NOT NULL,
  freq   INTEGER NOT NULL,
  PRIMARY KEY (script, word)
) WITHOUT ROWID;

-- Per-character facts. 14,625 rows. Small enough to be read into memory whole when the
-- store opens, which is what makes detectScript() stay synchronous after the port.
-- simp_evidence: some entry has simp = ch and trad <> ch.  trad_evidence: the mirror.
CREATE TABLE chars (
  ch            TEXT    NOT NULL PRIMARY KEY,
  simp_evidence INTEGER NOT NULL,
  trad_evidence INTEGER NOT NULL
) WITHOUT ROWID;

-- "Which words contain 算". 23,052 rows holding 636,088 postings as delta-varint blobs
-- of entries.rowid, ascending. One row per (character, script), NOT one row per
-- occurrence — see the size note below.
CREATE TABLE char_words (
  ch          TEXT    NOT NULL,
  script      TEXT    NOT NULL,
  n           INTEGER NOT NULL,
  rowids      BLOB    NOT NULL,
  PRIMARY KEY (ch, script)
) WITHOUT ROWID;

-- Build-time constants and provenance.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
```

`meta` rows, all required: `schema_version`, `dict_version` (the CC-CEDICT snapshot string — this is
the value that travels onto every card snapshot as `dictVersion` and its meaning must not change),
`built_at`, `sources` (the JSON `DictSource[]` today's `dict.meta.sources` carries, so `/settings`
still renders attribution from the data), `entry_count`, `words_total_simp`, `words_total_trad`,
`max_len_simp`, `max_len_trad`.

**rowid is the sort key.** Rows are inserted in the order `lib/dict/index.ts`'s `compareEntries`
produces — the order every existing index already uses. The consequence is worth stating plainly
because it removes work from every query: `ORDER BY rowid` **is** "frequency first, real words
before variants before proper nouns, then id", so no query ever needs the four-clause sort, no
client ever re-sorts a result set, and `SELECT ... WHERE simp = ? ORDER BY rowid` reproduces
`index.bySimp.get(simp)` exactly, including which id is "first" for `headwordFreq`.

**The segmenter's constants belong in the file, not the code.** `words_total_*` is the integer sum
`statsFor()` computes; the client takes `Math.log()` of it, so the DP's scores are bit-identical to
today's. `max_len_*` is `statsFor()`'s `maxLen`, including its quirk that headwords longer than
`MAX_WORD_CHARS = 16` do not raise it. For snapshot `1.3.20251213` these are
`words_total_simp = 55422515`, `max_len_simp = 15`, `words_total_trad = 64124174`,
`max_len_trad = 15` — *measured 2026-09-13 (this plan)*. They are constants of the snapshot, not of
the code, which is why they are data.

**Measured sizes, against this schema.** *Measured 2026-09-13 (this plan)*, VACUUMed,
`page_size = 4096`, real data:

| Cumulative | Raw | Audit's figure for the nearest equivalent |
|---|---|---|
| `entries` + unique id index | 24.7 MB | 23.5 MB |
| + `entries_simp`, `entries_trad` | 28.6 MB | 27.6 MB |
| + pinyin keys **as columns** + two indexes | 32.9 MB | 36.0 MB *(a separate key table)* |
| + `entries_hsk` | 34.3 MB | — |
| + `gloss_fts` (pre-stemmed, contentless, `detail=none`) | 37.1 MB | 40.7 MB *(porter over raw gloss text)* |
| + `words` | 41.7 MB | 43.3 MB |
| + `char_words` (varint blobs) | **43.1 MB** | 47.2 MB *(427k-row table)* |
| gzip -9 / brotli q11 of the finished file | 19.5 MB / **13.9 MB** | 21.5 MB / 15.4 MB |

Two of those rows are decisions, not luck. **Pinyin keys are columns on `entries`, not a side
table** — 3 MB cheaper and one fewer join. **`char_words` is a packed posting list.** The obvious
shape, one row per (character, script, entry), is 636,088 rows and costs **+22.4 MB**; the same
information as one delta-varint blob per (character, script) costs **+1.4 MB**. Both measured. If a
build session writes the obvious version the file gets 50% bigger for nothing, so this is called
out here rather than left to review.

The whole build — parse `dict.json`, insert 124k+242k+23k rows, create every index, six VACUUMs —
runs in **under 10 seconds** in this container.

**Naming, versioning, delivery paths.** `data/dict-<SCHEMA_VERSION>-<cedictVersion>.sqlite`, e.g.
`dict-1-1.3.20251213.sqlite`, beside `data/dict-manifest.json`
(`{file, bytes, sha256, schemaVersion, dictVersion, builtAt}`). Two version numbers because the
schema changes independently of the snapshot, and every cache key on every platform is the whole
filename. `data/` stays the single output directory and stays gitignored; each deployable's build
copies out of it (`web.md` to the Vite public dir, `ios.md`/`android.md` to the Capacitor asset
directories). Do not teach `pnpm data` about deployables.

**Licences.** The SQLite file is a modified CC-CEDICT derivative exactly as `dict.json` is:
`data/ATTRIBUTION.md` gains the file by name and its modification notice covers the same
derivations plus "reindexed into SQLite; pinyin lookup keys and gloss tokens derived mechanically".
`decomp.json` is **not** in the SQLite file and never will be — that separation is the licence rule
(CLAUDE.md, PLAN.md §5), and D1 must include a test that asserts the `.sqlite` contains no table,
column or value sourced from Make Me a Hanzi. SQLCipher's BSD notice is added in D5, when the
plugin that needs it arrives.

**Acceptance criteria.**

1. `pnpm data` on a clean `data/` produces `dict-1-<version>.sqlite` and `dict-manifest.json`; the
   manifest's `sha256` and `bytes` match the file.
2. `pnpm data:verify` exits 0 and prints a report. It must assert, against the freshly parsed
   `dict.json` in the same process:
   - `COUNT(*) FROM entries` equals `dict.entries.length` (124,188 for this snapshot);
   - **every entry round-trips**: for all 124,188 ids, the row rebuilt into an `Entry` deep-equals
     the JSON entry, `glosses` array order included;
   - rowid order equals `compareEntries` order for all rows;
   - `py_toneless`/`py_toned` equal what `LazyDictIndex.#buildPinyin` computes, including the
     `readingKeys() ?? normalizePinyin()` fallback and the `hasUnknownReading` exclusion, for all
     rows — this is `cold-start.test.ts`'s property, re-asserted against the file;
   - `words` has one row per distinct `(script, headword)` and its `freq` equals
     `headwordFreq(index, index.bySimp|byTrad.get(word))` for all 242,087 pairs;
   - `chars` reproduces `detectScript`'s per-character verdict for all 14,625 single-character
     headwords;
   - `char_words` postings decode to exactly the entry rowids whose `simp`/`trad` contains the
     character;
   - `gloss_fts` has a row for every non-variant entry with at least one gloss token and none for a
     variant;
   - every `meta` key is present and `dict_version` equals `dict.meta.version`.
3. `pnpm data:verify --sizes` prints the cumulative table above and fails if the finished file
   exceeds a committed budget (set it at 50 MB raw / 18 MB brotli, leaving headroom).
4. A test asserts no Make Me a Hanzi data reaches the `.sqlite`.
5. Re-running `pnpm data` on an unchanged snapshot produces a byte-identical file. If it does not,
   find the source of nondeterminism before proceeding — the web loader's cache key depends on it.

**What an adversarial review should attack here:** the round-trip test being weaker than
deep-equality; `words.freq` computed with SQL `MAX()` instead of by replaying `compareEntries` (they
differ when a jieba frequency is 0); the `char_words` shape; and whether `SCHEMA_VERSION` is
actually read from one place.

---

### D2 — The query layer, part 1: `DictStore` over a `SqlRunner`, in Node

**What it builds.** The two settle-first interfaces and the half of the query layer that is pure
B-tree work: entries by id, HSK bands, hanzi search, pinyin search, reading counts, decomposition.
Runs against the D1 file through `node:sqlite`. No browser, no device.

**Files.**

- `lib/dict/sql.ts` — new. The `SqlRunner` seam.
- `lib/dict/store.ts` — new. The `DictStore` interface and its status model.
- `lib/dict/sqlite-store.ts` — new. The one implementation of `DictStore`, written entirely against
  `SqlRunner`; it is shared by web and native and knows nothing about either.
- `lib/dict/runners/node.ts` — new. `SqlRunner` over `node:sqlite`, for tests and for any remaining
  server-side use.
- `lib/dict/query/{hanzi,pinyin,entries,hsk}.ts` — new. SQL builders, one per query family.
- `lib/dict/pinyin.ts` — **unchanged**. It is already dependency-free and pure.
- `lib/dict/index.ts` — the ranking and grouping helpers (`compareEntries`'s ordering,
  `parseIdList`, `stemToken`, `glossTokens`) survive; the `LazyDictIndex` class and the
  `getDict()`-backed accessors do not. Split rather than mutate: move the pure helpers to
  `lib/dict/rank.ts` and let `index.ts` die with the routes in D6.
- `tests/unit/dict/store.test.ts` — new, and the existing `index.test.ts` and `pinyin.test.ts` run
  unchanged.

**The two interfaces.** These are frozen once merged.

```ts
// lib/dict/sql.ts — the only thing that differs between platforms.
export type SqlValue = string | number | null | Uint8Array;
export interface SqlQuery { sql: string; params?: readonly SqlValue[] }
export interface SqlRunner {
  /** One round trip. Every query in the batch runs on the same read-only connection, in order. */
  query(batch: readonly SqlQuery[], signal?: AbortSignal): Promise<Record<string, SqlValue>[][]>;
  close(): Promise<void>;
}
```

```ts
// lib/dict/store.ts
export type DictStatus =
  | { state: 'absent' }                                   // nothing on device yet
  | { state: 'preparing'; received?: number; total?: number }
  | { state: 'ready'; version: string }
  | { state: 'failed'; reason: 'download' | 'import' | 'storage' | 'corrupt'; message: string };

export interface DictStore {
  readonly status: DictStatus;
  subscribe(listener: (status: DictStatus) => void): () => void;
  open(): Promise<void>;                       // idempotent; safe to call on every mount

  entries(ids: readonly EntryId[]): Promise<DictEntry[]>;
  search(query: string, options?: SearchOptions): Promise<SearchResult>;
  segment(text: string, options?: SegmentOptions): Promise<SegmentResult>;
  hskBand(band: HskBand, options?: { limit?: number; offset?: number }): Promise<DictEntry[]>;
  readingCount(simp: string): Promise<number>;
  wordsContaining(ch: string, options?: { script?: SegmentScript; limit?: number }):
    Promise<DictEntry[]>;
}
```

`DecompStore` is deliberately a **separate interface in a separate module**
(`lib/dict/decomp-store.ts`, `decompose(chars: string): Promise<DecompCharacter[]>`), backed by
`decomp.json`. Two interfaces because two licences; one object would invite one query.

**Two layers, and why.** `DictStore` is the domain API — it is what `core.md` codes against, and it
is the unit of batching. `SqlRunner` is a dumb pipe. Everything interesting (routing, ranking,
grouping, paging, the DP) lives in `sqlite-store.ts` and is written once for all three platforms.
The rule that makes the Capacitor bridge survivable is that **a `DictStore` method is at most two
`SqlRunner.query()` calls**, and each call is a batch. Budget:

| Method | Round trips | Why |
|---|---|---|
| `entries`, `hskBand`, `readingCount`, `wordsContaining` | 1 | |
| `search` | 2 | one batch to find candidate headwords, one to fetch every reading of them |
| `segment` | 2 | one batch for the candidate substrings of every hanzi run, one for the chosen words' entry ids |
| `open` | 1 | `meta` + the whole `chars` table |

Above the store, `sqlite-store.ts` also owns a small LRU of recent results keyed by
`(method, args)`, in-flight coalescing so two identical queries share one promise, and `AbortSignal`
support so a superseded keystroke's work is dropped rather than rendered. `core.md` still debounces
input; both are needed.

**Query shapes.** The interesting ones, with latency *measured 2026-09-13 (this plan)*, warm, native
SQLite 3.51.2, on the real file:

| Query | SQL | Measured |
|---|---|---|
| hanzi exact | `WHERE simp = ?1 OR trad = ?1 ORDER BY rowid` | 0.016 ms |
| hanzi prefix | `WHERE simp >= ?lo AND simp < ?hi ORDER BY rowid LIMIT 200` | 1.18 ms (200 rows) |
| pinyin exact | `WHERE py_toneless = ? ORDER BY rowid LIMIT 50` | 0.020 ms |
| pinyin prefix | `WHERE py_toneless >= ?lo AND py_toneless < ?hi ORDER BY rowid LIMIT 50` | 1.59 ms |
| by id | `WHERE id IN (…50…)` | 0.20 ms |

**The prefix trap that is not in the audit.** A prefix scan is a range scan, and the upper bound
must be the prefix with its **last code point incremented**, not the prefix with `￿` appended.
SQLite's default `BINARY` collation compares UTF-8 bytes; `U+FFFF` encodes as `EF BF BF` and any
astral-plane character (CJK extension B and beyond, which `CJK_PATTERN` in `search.ts` explicitly
includes) encodes as `F0 …`, so the naive sentinel silently drops exactly the rare headwords the
extension ranges exist for. No column may be declared `COLLATE NOCASE`, for the same reason. The
verifier in D1 has a case for this; the store must have a unit test for it.

**Pinyin normalization, in full, because the audit called it the hard part.** `lib/dict/pinyin.ts`
moves to the client **unchanged**, and the whole point is that the same function computes the stored
key at build time and the query key at query time. What must survive the port, each of which is a
test:

1. **Keys carry no separators.** `dasuan`, `da3suan4`. Unsegmented input is ambiguous (`xian` is 先
   or 西安) and the concatenated key resolves both by making them different keys; adding separators
   would make the query parser's job impossible instead of the index's.
2. **ü folding.** `u:`, `v`, `ü` and the accented `ǖǘǚǜ` all fold to `u`, on both sides. `unUmlaut`
   is applied only inside recognised syllables, so a Latin run like `TV` keeps its `v`.
3. **The neutral tone contributes no digit.** `wo3 men5` keys as `wo3men`, because no tone mark can
   write tone 5, so a learner typing `wǒmen` must land on the same key. Erhua `r5` falls out of the
   same rule. Get this wrong and every neutral-tone word — 我们, 什么, 东西, 朋友 — drops out of the
   tone-exact tier.
4. **`xx5` readings are excluded.** CC-CEDICT's marker for "no known reading" must produce NULL in
   both key columns, or a search for `xx` returns 34 unrelated characters. NULL is also what keeps
   them out of range scans for free.
5. **The two-function fallback.** The build uses `readingKeys(pinyinNum) ?? normalizePinyin(...)`,
   because `readingKeys` returns null for the 742 readings that are not plain numbered syllables.
   The build must use the identical expression, and `cold-start.test.ts`'s proof that the two agree
   on every reading must be carried over and re-run against the file.
6. **Capitalised proper nouns.** `readingKeys` lowercases; the `proper_noun` flag is a separate
   column and the ranking uses it, not the case of the key.
7. **Short prefixes.** `da` matches thousands of rows, so `ORDER BY rowid LIMIT` is **in the SQL**.
   Sorting after the fact would pull thousands of rows across the Capacitor bridge per keystroke.
8. Initial-letter search (`ds` → 打算) is **not** built; see §7.

**Acceptance criteria.**

1. `tests/unit/dict/index.test.ts` and `pinyin.test.ts` pass unchanged.
2. A new `store.test.ts` runs the store over the real D1 file through the Node runner and asserts,
   for a fixed list of at least 30 queries covering all of §5.2's traps, that
   `store.entries/hskBand/readingCount/wordsContaining` return exactly what today's
   `getEntries/hskBand/readingCount` return from the JSON index. This is a differential test against
   the old implementation, not a golden file — both are available in the same process.
3. Hanzi and pinyin search sections match the JSON implementation group-for-group and
   order-for-order on a fixed query list including `打`, `打算`, `da`, `dasuan`, `da3suan4`,
   `dǎsuàn`, `wǒmen`, `xian`, `lu:4`, `nu:3`, and one astral-plane headword.
4. A round-trip-count test asserts the budget in the table above by counting `SqlRunner.query`
   invocations against a spy runner. This is the only defence against per-keystroke bridge chatter,
   and it must fail if someone adds a third call.
5. `pnpm test` and `pnpm lint` pass. No module under `lib/dict/` imports `node:fs` any more except
   `load.ts` and `runners/node.ts`.

---

### D3 — The query layer, part 2: gloss search and the segmenter

**What it builds.** The two pieces the audit flagged as hard, kept apart from D2 because each ends
in a behavioural diff that has to be argued rather than asserted.

**Files.** `lib/dict/query/gloss.ts`, `lib/dict/rank.ts` (the `glossTier` machinery moved out of
`search.ts`), `lib/dict/search.ts` (rewritten as the router over the store),
`lib/dict/segment.ts` (inverted), `tests/unit/dict/{search,segment}.test.ts` (kept, re-pointed).

**`detail=none` is worse than the audit said, and the fix is better.** The audit's recommendation
was "FTS5 `porter unicode61`, contentless, `detail=none`, ranked with `bm25()`". Two of those things
do not work together:

- Phrase and NEAR queries raise an error, not an empty result:
  `fts5: phrase queries are not supported (detail!=full)`. So `"to plan"` must never be sent.
- **`bm25()` returns 0 for every row on a contentless `detail=none` table.** Reproduced on SQLite
  **3.51.2** via `node:sqlite` and on **3.45.1** via Python — *measured 2026-09-13 (this plan)*.
  The same corpus at `detail=full` returns real, discriminating scores (−4.95, −2.22); at
  `detail=none` it returns 0.0 for both rows. Contentless is what breaks it: `detail=none` **with**
  stored content ranks fine. Getting bm25 back therefore costs the audit's measured +3.4 MB for
  `detail=full`, or storing the gloss text twice.

**Do not buy it.** Tangram already has a ranking function that is better than bm25 for this corpus
and is already tested: `glossTier` in `lib/dict/search.ts`, which encodes PLAN.md §3.2's four
tiers (whole-gloss match, whole-gloss-minus-grammar-words, contiguous phrase, scattered words). It
runs on the ≤50 candidate rows and it is what makes `plan` rank 打算 above a gloss that merely
mentions planning. So **FTS5 is used as a posting-list store and nothing else** — precisely the role
`index.byGloss` plays today — and the plan is unchanged in substance:

```sql
SELECT e.rowid FROM gloss_fts f JOIN entries e ON e.rowid = f.rowid
WHERE f.gloss_fts MATCH ?  ORDER BY e.rowid  LIMIT 400;
```

`ORDER BY e.rowid` is the frequency ordering (§D1), which is exactly the ordering today's posting
lists have and which today's `MAX_GLOSS_CANDIDATES = 5000` slice depends on. Measured: 0.84 ms for
`"plan"`, 0.92 ms for `"to" AND "plan"`.

**Building the MATCH string is a security-shaped problem, not a formatting one.** FTS5 has its own
query syntax; an unescaped learner query is an injection. The rule: take the query through the same
`words()`/`lemma()` path `englishGroups` uses today, drop anything not matching `[a-z0-9']+`,
double-quote every term, and join with ` AND `. Irregular plurals become an OR group —
`("women" OR "woman") AND "who"` — because `IRREGULAR` is a query-time map that the index does not
know about. Never emit a bare `*`, a `^`, a `:` or a multi-word quoted string.

**Why the index stores pre-stemmed tokens rather than raw glosses.** If the table were
`porter unicode61` over raw gloss text, the build-time stemmer would be Porter and the query-time
stemmer would be `stemToken`/`lemma`, and the two disagree in both directions. Indexing
`glossTokens(gloss)` output under plain `unicode61` makes the tokenizer a whitespace splitter and
keeps one stemmer in the system — the one `cold-start.test.ts` already pins. It also measured
smaller (+2.8 MB against the audit's +4.7 MB). The one wrinkle it creates is the apostrophe:
`glossTokens` keeps `'` inside a token, and `unicode61` would split on it, so the table is declared
`tokenize="unicode61 tokenchars ''''"` — verified working, *measured 2026-09-13 (this plan)*.

**Two behavioural changes will show up in `search.test.ts`, and both are improvements.** FTS5's AND
is an exact posting-list intersection, where today's code intersects lists each truncated at 5,000
ids — so recall goes up for common words. And `isGlossToken()` (the `sun`/`can`/`women`-versus-`shi`
rule that decides which section leads) currently inspects up to 5,000 frequency-ordered candidates;
it must keep inspecting candidates **in `rowid` order** for the rule to behave the same. Do not
reorder that query by relevance. Every test that moves must be justified in the phase's writeup, one
line each; a moved test that cannot be justified is a bug.

**Inverting the segmenter.** STACK §2.5 hard part 5 is right and this is the shape:

```ts
export interface SegmentStats { logTotal: number; maxLen: number }
export interface SegmentInput {
  script: SegmentScript;
  stats: SegmentStats;
  /** word → headword frequency, for every ≤16-char substring of every hanzi run. */
  candidates: ReadonlyMap<string, number>;
  /** Every reading of a chosen word, in rowid order. Filled after the cuts are known. */
  idsFor: (word: string) => readonly EntryId[];
}
export function segmentWith(text: string, input: SegmentInput): SegmentResult;
```

`route()` — the DP itself, including `MAX_WORD_CHARS = 16` and jieba's `(score, end)` tie-break
where a longer word wins an exact tie — moves **byte-for-byte unchanged**. What changes is
everything that reaches into the index:

- `statsFor()` disappears; `logTotal` is `Math.log(meta.words_total_<script>)` and `maxLen` is
  `meta.max_len_<script>`, both read once at `open()`.
- `detectScript()` reads the `chars` table, which the store loads whole at `open()` (14,625 rows,
  two integers each). It therefore stays **synchronous** and its semantics are unchanged: a
  character is evidence only where the two scripts disagree about it, ties go to simplified.
- The candidate fetch is one `IN (...)` query per call over the distinct ≤16-char substrings of all
  hanzi runs. Measured on a 77-hanzi paragraph: 1,095 distinct substrings, **1.37 ms** for the
  single query. The second round trip fetches entry ids for the chosen words only.

**Acceptance criteria.**

1. `tests/unit/dict/segment.test.ts` passes **unchanged** against the store — the acceptance
   sentences (`我打算明天去北京`, `他有意见`, `研究生命的起源`), 把/手表 over 把手/表, and
   中华人民共和国 kept whole. This suite is the regression net for the inversion and it must not be
   edited to make the port pass.
2. `tests/unit/dict/search.test.ts` passes, with a written justification for each assertion that
   changed and a diff count in the phase writeup. Zero unexplained changes.
3. A differential test runs a fixed corpus of ≥200 English queries through both the JSON
   implementation and the store and reports group-set differences; the phase ships the report.
4. A fuzz test feeds FTS5-syntax metacharacters (`"`, `*`, `^`, `:`, `NEAR`, `AND`, `(`, unbalanced
   quotes, a 200-char query) through `search()` and asserts no SQLite error is ever raised.
5. A test asserts a phrase query is never constructed, by spying on the MATCH strings.
6. Round-trip budget from D2 still holds for `search` and `segment`.

---

### D4 — The web store: `sqlite-wasm` on OPFS in a worker

**What it builds.** `SqlRunner` for the browser, the one-time import, the status model wired to real
progress, and the fallback ladder. First platform, and the one that can be finished in the
container.

**Files.** `lib/dict/runners/wasm.ts`, `lib/dict/runners/wasm-worker.ts` (the dedicated worker),
`lib/dict/decomp-store.ts`, plus a Vite entry for the worker and the static asset path
(`web.md` owns the host config). New dependency: `@sqlite.org/sqlite-wasm` 3.53.4-build1 (STACK §6;
re-check the version before installing).

**The mechanism**, from STACK §2.5 and the dictionary audit:

1. The worker calls `sqlite3.installOpfsSAHPoolVfs()`. `opfs-sahpool` needs **no COOP/COEP headers
   and no SharedArrayBuffer** — decisive, because static hosts and embedded WebViews cannot set
   those, and Capacitor closed its custom-header issue as "not planned".
2. If the pool has no file named for the current manifest, `fetch()` the `.sqlite` and stream it in
   via `OpfsSAHPoolUtil.importDb(name, chunkCallback)` — the chunked form, so 43 MB never sits in
   memory at once. Verify the SHA-256 from the manifest as chunks arrive.
3. Open with the `opfs-sahpool` VFS through the `oo1` API, in the worker. Worker1/Promiser are
   deprecated (2026-04-15).
4. The main thread's `SqlRunner` is a `postMessage` bridge with the same batch-per-call contract as
   the Capacitor one, so the batching discipline is identical on both platforms and the round-trip
   test in D2 covers both.

**Serve it compressed.** 13.9 MB brotli against 43.1 MB raw, measured. This is a static file with a
content-addressed name, so `Cache-Control: public, max-age=31536000, immutable` and pre-compressed
`.br` served by content negotiation. `web.md` owns the host; this plan owns the requirement.

**States, because the first web load is 14 MB.** `absent` → `preparing` (with received/total from
the fetch, so `core.md` can show a determinate bar) → `ready`, or `failed`. Import is **idempotent
and keyed by the full artifact filename**, so an eviction is a re-download and a version bump is a
new file with the old one deleted. This replaces the existing `dict-data-missing` banner in
`components/shell/data-banner.tsx` one-for-one.

**The fallback ladder, in order.** (a) `opfs-sahpool` unavailable, or `importDb` fails → open an
in-memory database with `sqlite3_deserialize` (~43 MB of wasm heap, gone on reload). (b) That fails
too → `status.failed`, and the app runs without a dictionary; `core.md` must have that state drawn.
(c) A second tab: `opfs-sahpool` holds an **exclusive** lock per origin, so the second tab's open
fails and falls to (a). A SharedWorker is the eventual fix and is out of scope for v1 — see §7 —
but the second tab must not hang or throw an unhandled rejection, and there must be a test for it.

**`decomp.json` on the web.** 0.92 MB, fetched lazily the first time a character sheet opens, then
held by the service worker's Cache Storage. It is never imported into SQLite and `DecompStore` is
its own module. Add it to the offline precache list only if `web.md`'s budget allows; a missing
decomposition is a degraded panel, not a broken app.

**Acceptance criteria.**

1. A Playwright test in the container's Chromium loads a page that opens the store, waits for
   `ready`, and runs the same fixed query list D2 and D3 use, asserting identical results to the
   Node runner. Same assertions, different runner: that is the whole point of the seam.
2. **WASM latency is measured and reported** — this settles STACK known-unknown #10, whose "2–5×
   native" is an extrapolation nobody has run. Report the same seven queries D2 and D3 measured. If
   any interactive query exceeds 50 ms, stop and report rather than proceeding.
3. Reloading the page does **not** re-download: the second load reaches `ready` with zero network
   bytes for the artifact.
4. A test deletes the OPFS file mid-session and asserts the store recovers to `preparing` and back
   to `ready` rather than throwing.
5. A second-tab test asserts the fallback, not a hang.
6. The import is exercised once with a deliberately corrupt file and once with a truncated response;
   both must land in `status.failed` with a distinguishable `reason`.
7. `decomp.json` is fetched only after a decomposition is first requested — asserted by network log.

**Blocked-on-hardware note.** Register #4 — the reported 10 MB per-file OPFS cap in WKWebView — is
**not** answered by this phase, because the container has no Safari. The check is: import the real
43 MB file into `opfs-sahpool` on desktop Safari and on an iPhone. Until someone runs it, the web
dictionary on Apple platforms is unproven, and the fallback if it fails is the in-memory
`sqlite3_deserialize` path (which the same 10 MB claim would not affect) or the bare-table variant
in §7. Do not let this phase claim completion on Safari.

---

### D5 — The native store: the Capacitor plugin runner and the bundled asset

**What it builds.** `SqlRunner` over `@capacitor-community/sqlite`, the first-launch copy, and the
answers to four register entries. **This phase cannot start without a Mac with Xcode 26, a physical
iOS 26 device and at least one Android phone** (STACK §4 preconditions).

**Files.** `lib/dict/runners/capacitor.ts`, the asset copy step in each platform's build (owned
jointly with `ios.md`/`android.md`), `data/ATTRIBUTION.md` (SQLCipher's BSD notice).

**The mechanism.** Ship `dict-<schema>-<cedict>.sqlite` as an app asset. On first launch and
whenever the manifest's filename differs from what is in app storage, `copyFromAssets()` it into
app storage and open it **read-only**. The plugin bundles SQLCipher's own SQLite, which is what
makes FTS5 availability independent of the OS SQLite version.

**Budget the file twice.** It sits compressed in the package **and** expanded in app storage after
the copy: roughly 14 MB + 43 MB ≈ 57 MB on device. Every size estimate in `ios.md` and `android.md`
must use the doubled figure.

**Bundling ties dictionary updates to store releases.** That is the trade, stated so it is chosen
rather than discovered. If it ever becomes unacceptable, delivery switches to
download-on-first-launch, which is the same file, the same manifest, the same versioning and the
same `SqlRunner` — only `open()`'s first branch changes.

**Four register entries are settled in this phase, in one device session:**

| # | Question | The check |
|---|---|---|
| 20 | Is FTS5 compiled into the SQLCipher **iOS** pod? Verified for Android only. This is the claim that makes "one file, no per-platform build" true. | Open the copied asset and run `SELECT sqlite_version()` and `SELECT * FROM gloss_fts WHERE gloss_fts MATCH '"plan"' LIMIT 1`. |
| 6 | Do `ATTACH` and the `immutable=1` URI flag pass through the plugin? | Call both; read the error. Not fatal either way — two connections work — but it decides whether the dictionary and the learner's database can share a connection. |
| 18 | How long does `copyFromAssets()` of a 43 MB file take, and what does it cost in storage? Nobody has measured it. | Time it on the lowest-spec Android target and on an iPhone, with the device near-full as well as empty; record peak storage. |
| 5 | Does the plugin ship 16 KB-page-aligned `.so` files? A misaligned one is a Play **rejection**. | `zipalign -c -P 16 -v` on a real AAB. Owned by `android.md`, but it blocks this artifact reaching a store. |

**Batching is the whole performance story here.** Every `SqlRunner.query()` is one JSON round trip
across the bridge (~1–5 ms plus result serialisation). The D2 round-trip test is what keeps a
keystroke at two calls; run it against this runner too. If measurement shows two trips per search is
too many on a real device, the fix is a correlated subquery that fetches candidate headwords and all
their readings in one statement — `WHERE simp IN (SELECT simp FROM entries WHERE simp >= ? AND
simp < ? ORDER BY rowid LIMIT 200)` — not a cache in front of a chatty API.

**Acceptance criteria.**

1. The same fixed query list from D2/D3/D4 returns identical results through the Capacitor runner on
   both a real iPhone and a real Android device.
2. Register entries 20, 6 and 18 have written answers with the command and the output. A phase that
   cannot run these because there is no hardware is **blocked, not complete**.
3. Cold-launch time with the dictionary open is measured on the named low-end Android target (STACK
   §4 requires naming one) and compared against Play's 5 s flag.
4. The first-launch copy is a visible, one-time progress state with a designed low-storage failure
   path — neither exists in any screen today; `core.md` owns drawing them, this phase owns the
   states.
5. SQLCipher's BSD notice is in `data/ATTRIBUTION.md` and rendered in the app.
6. `typeof window.speechSynthesis` is logged from the Capacitor Android WebView while a device is in
   hand (register #19, five seconds, belongs to `android.md` but costs nothing here).

---

### D6 — Retire the server dictionary

**What it builds.** Nothing. It deletes. Runs last, after `core.md` has re-pointed every consumer
and `backend.md` has settled the `/api/ask` contract.

**What goes.**

| Today | Replacement |
|---|---|
| `GET /api/dict/entries?ids=` | `store.entries(ids)` |
| `GET /api/dict/hsk?band=` | `store.hskBand(band, {limit, offset})` |
| `GET /api/dict/search?q=` | `store.search(q, opts)` |
| `POST /api/dict/segment` | `store.segment(text, opts)` |
| `GET /api/dict/decomp?chars=` | `decompStore.decompose(chars)` |
| `lib/dict/client.ts`, `DictRequestError` | deleted; `DictRequestError.dataMissing` becomes `DictStore.status` |
| `lib/dict/load.ts`, `lib/dict/index.ts`'s `LazyDictIndex` | deleted with the routes |
| `next.config.ts` `outputFileTracingIncludes` | deleted with `next.config.ts` (`web.md`) |
| `scripts/smoke.ts` and `lib/server/route-inventory.ts` dict cases | deleted; their replacement is `web.md`'s and `backend.md`'s call (STACK §7 flags that nothing yet replaces "every route is exercised on a built server") |
| `tests/e2e/p1/dict-api.spec.ts` | replaced by D4's Playwright store test |
| `data/dict.json` | see below |

**The API contract change nobody should discover at runtime.** `hskBand` gains `limit`/`offset`
because it now crosses a bridge instead of a socket; `lib/lists/entry-source.ts` is the consumer to
fix. Everything else keeps its shape: `SearchResult`, `SegmentResult`, `EntriesResponse.entries` and
`DecompResponse.characters` are the same types, minus the `meta` wrapper, since the version is now
`store.status.version`.

**What this plan owes the three model routes.** They read the dictionary today; under STACK §5.5's
recommendation the client retrieves and the server does not. This plan provides the client-side
equivalents — the `mergedSearch()` and `candidateEntries()` logic from `app/api/ask/route.ts` moved
to `lib/ai/retrieve.ts` over `DictStore` — and one thing that needs stating because it is a real
mismatch: **`GroundContext.segment` is synchronous** (`lib/ai/ground.ts:403`) and `DictStore.segment`
is not. The fix is not to make `ground.ts` async — `tests/unit/ai/` encode its rules and should not
be churned. The fix is for the caller to `await store.segment()` for each rendered phrase up front,
build a `Map<string, Token[]>`, and pass `(text) => map.get(text) ?? []`. `entry` and `readings`
resolve the same way, from an awaited batch. Whether the client or the server calls the model, and
what goes on the wire, is `backend.md`'s.

**`data/dict.json`'s fate.** Keep emitting it through D6, because it is the differential-test oracle
for every phase above and it is `verify-data.ts`'s input. Then decide: either `pnpm data` stops
writing it and `verify-data.ts` builds the entry list in memory instead, or it stays as a build
intermediate. Recommendation: keep it as an intermediate — it costs nothing (it is gitignored and
the build is under 10 s) and it is the only thing that can ever answer "did the SQLite build change
the data".

**Acceptance criteria.**

1. `grep -r "api/dict" --include=*.ts --include=*.tsx` returns nothing outside history.
2. No module outside `scripts/` and `lib/dict/runners/node.ts` imports `node:fs`.
3. The app runs with the network offline from a cold start, once the dictionary is `ready`:
   lookup, search, segmentation of a pasted passage and the character sheet all work.
4. `pnpm test` passes with the dictionary suites running against the store, not the routes.
5. A test asserts the app boots with **no** dictionary present and shows the `absent` state rather
   than throwing — the missing-data banner's successor, and the same promise CLAUDE.md makes today
   ("missing data is a banner, not a crash").

---

## 6. Risks

Each row: the trigger that says it is happening, and the mitigation. The register numbers are
STACK §4's.

| Risk | Trigger | Mitigation |
|---|---|---|
| **OPFS per-file cap in WKWebView (#4).** One third-party README claims 10 MB per file; WebKit's published policy is a per-origin quota. The web dictionary is 43 MB. | `importDb` throws or truncates on desktop Safari or on an iPhone. | The check: import the real file into `opfs-sahpool` on desktop Safari and on an iPhone, **before** D4 is called done. If it fails: `sqlite3_deserialize` in-memory (~43 MB wasm heap, per-session), or the bare-table variant (§7), or Safari web users get lookup through the server while native and Chromium get the file. Needs a Mac; nothing in this container answers it. |
| **FTS5 missing from the SQLCipher iOS pod (#20).** Verified for the Android artifact only. | `CREATE VIRTUAL TABLE … USING fts5` or a `MATCH` fails on iOS. | D5's device session runs the check. If it fails, "one file everywhere" survives — only English gloss search on iOS breaks — and the fallback is a `LIKE`-based gloss query over `entries.glosses` (slow but correct) or a different plugin. Do not discover this after the schema is frozen. |
| **`copyFromAssets()` of 43 MB is slow or fails on a full device (#18).** Unmeasured by anyone. | First launch hangs, or fails on a device near storage capacity. | Measure in D5 on the lowest-spec target, empty and near-full. Design the one-time progress state and the low-storage failure path as part of the phase, not after. |
| **WASM query latency is worse than the 2–5× extrapolation (#10).** Nobody measured a browser. | D4's measurement shows an interactive query over ~50 ms. | Measured in D4 against the same seven queries. Levers, in order: fewer round trips (the correlated-subquery form), a smaller `LIMIT`, prepared-statement reuse in the worker, and moving the debounce up. |
| **`ATTACH`/`immutable=1` do not pass through the plugin (#6).** | The call errors on device. | Two connections work; only the query layer's shape changes. Checked in D5's same session. |
| **Search behaviour drifts during the D3 port.** FTS5's exact AND replaces truncated posting-list intersection, and `isGlossToken`'s candidate order decides which section leads. | `search.test.ts` assertions move, or `sun`/`shi`/`women` route to the wrong section. | The differential test over ≥200 queries in D3, and the rule that every changed assertion carries a one-line justification. `isGlossToken` must inspect candidates in `rowid` order. |
| **The prefix range sentinel drops astral-plane headwords.** Not an audit item; found while writing this plan. | Extension-B headwords stop appearing in prefix search while exact search still works. | Increment the last code point of the prefix; never append `U+FFFF`. No `COLLATE NOCASE`. Unit test in D2 with a real astral headword. |
| **`words.freq` diverges from `headwordFreq()`.** SQL `MAX(freq)` and replaying `compareEntries` differ where a jieba frequency is 0 or absent. | `segment.test.ts` fails on a sentence nobody wrote a case for. | Compute it in TS at build time and assert equality for all 242,087 pairs in `verify-data.ts`. |
| **`node:sqlite` is experimental** and could change across Node minors. | The build script breaks after a Node upgrade. | Pin Node ≥ 22.22 in `engines` (React Router 8 requires it anyway) and keep the builder's SQLite usage to plain `exec`/`prepare`/`run`/`all`. Fallback is `better-sqlite3` as a devDependency; the container has no `sqlite3` CLI, so do not plan on one. |
| **The build is not reproducible**, so the content-addressed filename churns and every client re-downloads 14 MB. | Two `pnpm data` runs on the same snapshot produce different bytes. | D1 acceptance criterion 5. Fixed insert order, no timestamps inside indexed data (`built_at` lives in `meta` only), single final `VACUUM`. |
| **Licence leakage.** `decomp.json` merged into the SQLite file, or the CC BY-SA attribution not shipped with the new artifact. | A `decomposition` column appears; `/settings` stops naming the sources. | D1's test asserting no Make Me a Hanzi data in the `.sqlite`; `meta.sources` carries the same `DictSource[]` the JSON does so `/settings` renders from data; SQLCipher's BSD notice added in D5. |
| **Bundling couples dictionary updates to store review.** | A CC-CEDICT fix needs a release. | Accepted for v1 and written down. The escape is download-on-first-launch: same file, same manifest, one branch in `open()`. |
| **Store-release size on Android.** 14 MB compressed is far under Play's 200 MB base-module cap, but the doubled on-device footprint is 57 MB. | Nothing yet; watch the Play Console's reported download size after the first upload (#16). | Nothing to do; recorded so the number is not a surprise. |

Two items the audits could not verify that this plan **does not** depend on, recorded so nobody
re-opens them here: whether ITP's seven-day eviction reaches WKWebView (#3) — the dictionary is a
re-downloadable cache and the learner's data is `core.md`'s and `backend.md`'s problem; and the
store compression ratio (#16).

One error in a source document, flagged so a build session does not chase it: **STACK.md §5.7 refers
to `data/hsk.json`. No such file exists.** HSK bands live on `Entry.hskBand` inside `dict.json`, and
after D1 in `entries.hsk_band`. Anything built on that sentence needs re-reading.

---

## 7. Out of scope for v1

- **Initial-letter search** (`ds` → 打算). A third key column, roughly +3 MB by the audit's estimate.
  The app does not do it today and nobody has asked for it. It is a column and an index away
  whenever it is wanted.
- **Full-text search inside Chinese text** — example sentences, Chinese-language gloss text, the
  learner's own notes. This is the one thing that would break the whole design: it needs a
  bigram/trigram tokenizer, which means a custom `sqlite-wasm` build (the official one sets
  `SQLITE_OMIT_LOAD_EXTENSION`) and per-platform native builds of the same tokenizer.
  `wangfenjin/simple` is the serious candidate and has no browser story. If this becomes a
  requirement, §2.5 of STACK.md reopens, not just this plan.
- **`detail=full` and real bm25.** +3.4 MB for a ranking function Tangram does not use, given
  `glossTier` already exists and is tested. Revisit only if `glossTier` is retired.
- **The bare-table variant** (ship ~20 MB, build indexes on device). STACK §3 flags the audit's
  compressed figures for it as implausible; they are now settled — *measured 2026-09-13 (this
  plan)*: bare `entries` table is **20.0 MB raw, 8.5 MB gzip -9, 6.2 MB brotli q11**, and the six
  B-tree indexes rebuild in **0.46 s**. So the audit's 11.9 MB brotli figure was wrong and the real
  saving is 13.9 → 6.2 MB brotli, larger than STACK supposed. It is still not the v1 shape, for a
  reason the audit missed: `gloss_fts` and `char_words` **cannot** be rebuilt from the bare table in
  SQL, because the gloss tokenizer and the character split are TypeScript. Only `words` is a single
  SQL statement. The on-device work is therefore a 124k-row TS loop nobody has timed in a WebView,
  not 0.46 s of SQL. Keep it as the documented fallback if the OPFS cap bites, and time that loop
  before believing in it.
- **A SharedWorker for multi-tab web.** `opfs-sahpool`'s exclusive lock means the second tab falls
  back to in-memory. Correct, not elegant. A SharedWorker fronting one connection is the fix and it
  can be added without touching `DictStore`.
- **Download-on-first-launch on mobile.** Bundling is chosen; the alternative is one branch away.
- **A second dictionary source**, Chinese-language definitions, example sentences in the artifact,
  and stroke-order graphics (Make Me a Hanzi's SVGs are Arphic PL and are not used).
- **Trigram FTS over `simp`/`trad`.** Measured at +3.4 MB by the audit and unable to answer the 1–2
  character queries that are **71,232 of the 120,448 distinct simplified headwords** — *measured
  2026-09-13 (this plan)*, confirming the audit's "75k of 120k" shape. The B-tree plus `char_words`
  covers every Chinese query without it.
- **Astro static per-word pages** (STACK §5.7). They consume this plan's output but belong to
  `web.md`, and the measurement that decides them — Astro's build time at 124,188 pages — is
  `web.md`'s to run.
