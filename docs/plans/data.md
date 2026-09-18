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
three files into `data/`: `dict.json` (35.1 MB, 124,188 entries), `decomp.json` (0.92 MB) and
`COPYING-makemeahanzi`. **`data/` itself is not gitignored** — `.gitignore` ignores exactly
`data/*.json`, with the comment "the licence texts beside them are committed", and `git ls-files
data/` returns `ATTRIBUTION.md` and `COPYING-makemeahanzi`. So `COPYING-makemeahanzi` is both
generated and tracked, and anything this plan adds to `data/` that is not a `.json` file will be
offered to `git add` unless `.gitignore` is changed; D1 changes it. `data/ATTRIBUTION.md` is
committed and rendered in `/settings`. The generator derives `pinyinMarked` with
`lib/dict/pinyin.ts`, lifts `CL:` references into `classifiers[]`, joins HSK bands onto entry ids,
and attaches jieba `freq`/`freqRank`.

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
and a `DictStore` is async. **The resolution is in phase D3**, with `packages/ai/retrieve.ts`.
(Earlier drafts of this document cited "`data.md` §5.7" for this. There is no §5.7 — §5 has seven
phases — and the material moved from D6 to D3 when the `backend.md` gate cycle was broken. **D3 is
the reference.** `core.md` carried the same stale citation and no longer does, so this note is kept
only so the dangling reference stays findable, not because anything still makes it.)

**`lib/ai/**` has already moved by the time this plan writes into it.** Wave 0 creates
`packages/ai/` and moves all ten existing `lib/ai/**` modules into it in one commit
([wave-zero.md](wave-zero.md) §5), so every `lib/ai/…` path in this section is a HEAD fact and the
post-wave-0 spelling is `packages/ai/…`. That is why D3 writes `packages/ai/retrieve.ts` into a
directory that already exists, and why there is no gate between this plan and `backend.md` B1.

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
   particular it freezes `package.json`, whose `data:ensure` guard D1 must change, and it declares
   `data/*.json` the only generated output. (`lib/types.ts` is also frozen; D1 should *not* need to
   change it — see D1's Files.) Do this first, as its own commit, or every phase below fights the
   instructions.
2. **The repository/workspace layout is settled** ([wave-zero.md](wave-zero.md) §1): one pnpm
   workspace, `web.md` W0 executes the move, and `data/` and `scripts/` **stay at the workspace
   root** because three deployables consume `pnpm data`'s output. Each deployable's build copies
   out of `data/`. Wave 0 also creates `packages/ai/` and moves the ten existing `lib/ai/**`
   modules into it, which is the directory D3 writes `retrieve.ts` into.
3. Nothing else. Phases D1–D4 run entirely in this Linux container with no hardware.

**Sibling-plan gates:**

| Phase | Needs |
|---|---|
| D1, D2, D3 | Nothing. They are pure TypeScript against Node's own SQLite. |
| D4 (web store) | `web.md` must have reached the point where a Vite build exists and can serve a static asset and run a worker. It does **not** need the shell rewritten. |
| D5a (native store, Android) | `android.md` must have a Capacitor Android project that builds and installs, and **an Android phone** must exist. No Mac and no iOS device. |
| D5b (native store, iOS) | `ios.md` must have a Capacitor iOS project that builds and installs, and **a Mac with Xcode 26 and a physical iOS 26 device** must exist. Consumes D5a's `lib/dict/runners/capacitor.ts` unchanged. |
| D6 (retire the routes) | `core.md` must have re-pointed every consumer in §3 at `DictStore`, and **`backend.md`'s first B2 commit** — the frozen ask/answer contract, which `backend.md` §4 says lands there — must exist. Not all of B2: `backend.md` B2 gates on `packages/ai/retrieve.ts`, which this plan builds in **D3**, so gating D6 on the whole of B2 would deadlock the two documents. |

**What other plans may start against, and when.** The `DictStore` and `SqlRunner` interfaces, the
`DictStatus` union and the SQL schema are settle-first surfaces (STACK §7). They land as the **first
commit of D1** — `lib/dict/sql.ts`, `lib/dict/store.ts`, `lib/dict/decomp-store.ts` (types only)
and `lib/dict/schema.sql`, type declarations with nothing behind them — and are frozen from then on.
`core.md` may code against `DictStore` from that commit, with a hand-written fake first and the
in-Node implementation from D2/D3 as its test double, long before D4, D5a or D5b exist. `core.md`
(§4's gate table) and `ios.md` (§4) both gate on exactly this commit, so D1 is not allowed to reorder it
behind the builder.

---

## 5. Phases

Seven phases. D1–D3 are container-only and should be done first and in order; D4, D5a and D5b are
each independent of the others' hardware; D6 is the cleanup that can only run last.

### D1 — The artifact: `pnpm data` emits one SQLite file

**What it builds.** Two things, in two commits, in this order. **The first commit lands the frozen
interfaces**: `lib/dict/sql.ts`, `lib/dict/store.ts` and `lib/dict/decomp-store.ts` as type
declarations with no implementation behind them, plus `lib/dict/schema.sql`. That commit is what
`core.md` (its §4 gate table) and `ios.md` (§4) wait on, and nothing in it needs the builder
to exist. **The rest of the phase** is the builder, the verifier and the size/latency report. At the
end of the phase `data/` holds a `.sqlite` file that provably contains the same dictionary
`data/dict.json` does, and no *behaviour* has changed anywhere in the app — but several files
outside `scripts/` are touched, listed below, and "no app code changes" would be a lie.

**Files.** First commit:

- `lib/dict/schema.sql` — new. The canonical DDL, read by the builder at build time and by the
  verifier. One file so there is exactly one copy of the schema.
- `lib/dict/sql.ts`, `lib/dict/store.ts`, `lib/dict/decomp-store.ts` — new, **types only**. The
  `SqlRunner`, `DictStore`, `DictStatus`, `DecompStore` and `DecompCharacter` declarations, printed
  verbatim in §D2 and §D4 where the implementations are discussed. They compile, they export, and
  nothing implements them until D2. Frozen from this commit.

Then:

- `lib/dict/artifact.ts` — new. Artifact naming, `SCHEMA_VERSION`, the `application_id` magic, the
  manifest shape. Imported by the builder, the verifier and both stores.
- `lib/dict/rank.ts` — new, and it starts almost empty: `compareEntries` **moves here from
  `lib/dict/index.ts` and becomes exported**, because the builder must insert rows in exactly that
  order and the verifier must re-check it. `index.ts` imports it back, so nothing else changes.
  D2 and D3 add to this file rather than creating it.
- `lib/dict/segment.ts` — `headwordFreq` becomes **exported**. One word added; no behaviour change.
  It is the second function the builder and the verifier must call rather than re-implement, and
  re-implementing it is exactly the bug the "`words.freq` diverges" risk row describes.
- `scripts/build-data.ts` — extended: after building the in-memory `DictEntry[]` it now also writes
  the SQLite file and the manifest. Keep writing `dict.json` in this phase; D6 decides its fate.
- `scripts/verify-data.ts` — new, wired as `pnpm data:verify`.
- `package.json` — the `data:ensure` guard. `scripts/build-data.ts:443` currently returns early when
  `data/dict.json` exists, and `pnpm build` runs `data:ensure`, so after D1 **any tree that already
  has `dict.json` would never generate the `.sqlite`**. The guard must test for the artifact named
  by `dict-manifest.json`, not for `dict.json`. (`package.json` is on CLAUDE.md's frozen list; see
  §4 dependency 1. No dependency is added — this is a script-line change.)
- `tests/unit/dict/data-required.ts` — same blind spot in the test harness: it checks only for
  `dict.json`, so from D2 onward a store test against a missing or stale artifact would fail with a
  raw SQLite error instead of "run `pnpm data`". It must require the manifest and the file it names.
- `.gitignore` — add `data/*.sqlite`. Today the only rule is `data/*.json`, so a 43 MB binary is one
  `git add` away from the history. `data/dict-manifest.json` is already covered by `data/*.json`
  and **stays ignored deliberately**: it is a content hash of a generated file, and committing a
  hash of something nobody has generated is a stale fact waiting to happen.
- `lib/types.ts` — touched only if `Entry` needs a change. It should not: the 18 non-rowid columns
  of `entries` below are the 15 fields of `Entry` (`lib/types.ts:22-48`) plus the two derived pinyin
  keys and `hsk_sort`. Confirm rather than assume, and note the one trap — `classifiers` is
  `string[]`, never optional, so a NULL column must rebuild as `[]`, not `undefined`, or the
  round-trip in criterion 4 fails on all 124,188 rows.
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
  -- freq_rank with NULL folded to a sentinel, for banded rows only. It exists because
  -- hskBand() is the one accessor that does NOT use rowid order: index.ts:257-264 re-sorts
  -- each band by `freqRank ?? Number.MAX_SAFE_INTEGER`, so the 51 banded entries with no
  -- jieba rank (6 of them in band 1) come LAST. SQLite orders NULLs FIRST, so indexing
  -- freq_rank directly would put those six at the head of the beginner's HSK 1 list.
  -- Folding the sentinel into a column, rather than writing NULLS LAST or an expression
  -- index, keeps the ordering a plain index scan on every SQLite the artifact may meet.
  hsk_sort       INTEGER,
  freq           INTEGER
);
CREATE UNIQUE INDEX entries_id     ON entries(id);
CREATE INDEX        entries_simp   ON entries(simp);
CREATE INDEX        entries_trad   ON entries(trad);
CREATE INDEX        entries_py_tl  ON entries(py_toneless);
CREATE INDEX        entries_py_td  ON entries(py_toned);
CREATE INDEX        entries_hsk    ON entries(hsk_band, hsk_sort);

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
-- The domain is every (character, script) pair such that SOME headword of that script
-- contains the character, and nothing else: 11,067 simp + 11,985 trad = 23,052 —
-- *measured 2026-09-13 (this plan)*. Note that this is a different, larger domain than
-- `chars`, which is keyed on the 14,625 single-character headwords. A builder that
-- indexes only single-character headwords produces a table that decodes correctly and
-- is wrong; criterion 4 checks the row set, not just the postings.
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
`sources` (the JSON `DictSource[]` today's `dict.meta.sources` carries, so `/settings` still renders
attribution from the data), `entry_count`, `words_total_simp`, `words_total_trad`, `max_len_simp`,
`max_len_trad`.

**There is deliberately no `built_at`, and no `builtAt` in the manifest.** `scripts/build-data.ts:419`
stamps `dict.json`'s meta with `new Date().toISOString()` and that is fine for a build intermediate,
but a wall-clock timestamp inside the `.sqlite` changes its bytes and its sha256 on every run, which
would make acceptance criterion 7 — byte-identity — fail on the second build of every clean tree and
send a build session hunting a nondeterminism that is its own schema. Provenance is already carried,
without a clock: `schema_version` and `dict_version` in `meta`, both again in the filename, and the
sha256 in the manifest. `DictMeta.builtAt` in `lib/types.ts` is unaffected — `dict.json` keeps it —
and nothing renders it (`grep builtAt` finds one writer, one type field and one test).

**rowid is the sort key.** Rows are inserted in the order `compareEntries` produces — the order
every existing index already uses. The consequence is worth stating plainly because it removes work
from every query: `ORDER BY rowid` **is** "frequency first, real words before variants before proper
nouns, then id", so no query needs the four-clause sort, no client re-sorts a result set, and
`SELECT ... WHERE simp = ? ORDER BY rowid` reproduces `index.bySimp.get(simp)` exactly, including
which id is "first" for `headwordFreq`.

**The one exception is HSK.** `index.ts:257-264` builds `byHsk` from the `compareEntries`-sorted
list and then *re-sorts each band* by `freqRank ?? Number.MAX_SAFE_INTEGER`. Raw frequency and jieba
rank agree almost everywhere, which is why the code's own comment calls the re-sort a formality, but
they do not agree about the 51 banded entries that have no `freqRank` at all — 6 of them in HSK 1,
7 in HSK 2, 26 in the 7–9 band (*measured 2026-09-13 (this plan)*). Those belong at the tail.
`hskBand` is therefore the one query that does not order by rowid; it orders by
`hsk_sort, rowid`, where `hsk_sort` is the sentinel-folded column above. The `rowid` tie-break is
not decoration: `Array.prototype.sort` is stable and its input is already `compareEntries` order, so
entries sharing a `freqRank` keep frequency order today and must keep it after the port. This
matters more than 51 rows suggests, because product-decisions §3 moves `spineStartBand` from 3 to
**1** and promises "new words come from HSK 1, easiest first" — HSK 1 is the default band and it is
the one with six of the nulls.

One consequence for the size table below: it was measured with `entries(hsk_band, freq_rank)` and no
`hsk_sort`, and the swap adds one mostly-NULL integer column to 124,188 rows. D1 re-runs the size
report rather than assuming the difference rounds away.

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

The whole build — parse `dict.json`, insert 124k+242k+23k rows, create every index, VACUUM — runs in
**under 10 seconds** in this container. That figure was taken from a run that VACUUMed six times,
once per row of the table above, because each row is a separate size measurement. **The build itself
performs a single final `VACUUM`**, as the reproducibility risk row prescribes; six is an artefact of
measuring, not a build step, and a build session that implements six has misread this paragraph.

**Naming, versioning, delivery paths.** `data/dict-<SCHEMA_VERSION>-<cedictVersion>.sqlite`, e.g.
`dict-1-1.3.20251213.sqlite`, beside `data/dict-manifest.json`
(`{file, bytes, sha256, schemaVersion, dictVersion}` — no `builtAt`, see above). Two version numbers
because the schema changes independently of the snapshot, and **every cache key on every platform is
the whole filename**, not the hash: the sha256 is a build- and CI-side integrity fact, not a cache
key. `data/` stays the single output directory; each deployable's build copies out of it (`web.md`
to the Vite public dir, `ios.md`/`android.md` to the Capacitor asset directories). Do not teach
`pnpm data` about deployables. As §3 notes, `data/` is not itself ignored — `.gitignore` gains
`data/*.sqlite` in this phase.

**`char_words` closes an open decision, on purpose.** STACK §5.6 — "Does the `chars` infix table
ship in v1?" — is explicitly undecided, and its open half points away from shipping: *"To decide:
whether that panel searches the whole dictionary or only the learner's own words. If only their own
words, the table is unnecessary."* product-decisions §4 Rule 2 asks only for "the words **the
learner already has** containing it", which is an `allCards()` filter in `lib/db` and belongs to
`core.md`; `core.md` C4 builds exactly that, says the dictionary-wide variant "is `data.md`'s call,
not this plan's", and builds the panel so the list is a prop. **This plan makes the call: ship the
table.** Two reasons. It costs **+1.4 MB** in the packed-posting shape measured above — an order of
magnitude less than STACK's +3.9 MB estimate for the naive shape, which is what §5.6 was weighing.
And the schema is frozen at the end of this phase, so the alternative is not "add it later" but
"bump `SCHEMA_VERSION` and re-ship 43 MB to every device later". Shipping the strictly larger
capability at 3% of the file is the cheap side of that trade. If `core.md` never renders it, the
cost is 1.4 MB of dead index and `wordsContaining` is an unused method, which is recoverable; the
reverse is not.

**Licences.** The SQLite file is a modified CC-CEDICT derivative exactly as `dict.json` is:
`data/ATTRIBUTION.md` gains the file by name and its modification notice covers the same
derivations plus "reindexed into SQLite; pinyin lookup keys and gloss tokens derived mechanically".
`decomp.json` is **not** in the SQLite file and never will be — that separation is the licence rule
(CLAUDE.md, PLAN.md §5), and D1 must include a test that asserts the `.sqlite` contains no table,
column or value sourced from Make Me a Hanzi. SQLCipher's BSD notice is added in D5a, when the
plugin that needs it arrives.

**Acceptance criteria.**

1. The first commit's four files compile under `tsc` and `pnpm lint`, export `SqlRunner`,
   `SqlQuery`, `SqlValue`, `DictStore`, `DictStatus`, `DecompStore` and `DecompCharacter`, and have
   **no implementation behind them**. This is a real gate, not a formality: it is the commit
   `core.md` and `ios.md` are waiting on, and it is done when a sibling plan can write
   `const store: DictStore = fake` and have it type-check.
2. `pnpm data` on a clean `data/` produces `dict-1-<version>.sqlite` and `dict-manifest.json`; the
   manifest's `sha256` and `bytes` match the file.
3. `pnpm data:ensure` on a tree that already holds `dict.json` but no `.sqlite` **regenerates the
   artifact**, and `pnpm build` therefore cannot produce a build with a stale or missing dictionary.
   This is the guard at `scripts/build-data.ts:443`; without this criterion the normal developer
   path silently skips the whole phase's output.
4. `pnpm data:verify` exits 0 and prints a report. It must assert, against the freshly parsed
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
   - `char_words` has a row for **exactly** the `(character, script)` pairs such that some headword
     of that script contains that character — 11,067 simp + 11,985 trad = 23,052 for this snapshot —
     and no others. This half is separate from the next because a builder that indexes only
     single-character headwords passes the next one;
   - each `char_words` posting list decodes to exactly the entry rowids whose `simp`/`trad` contains
     the character, ascending;
   - `hsk_sort` equals `freq_rank ?? <sentinel>` for every banded row and NULL for every unbanded
     one, and `SELECT id FROM entries WHERE hsk_band = ? ORDER BY hsk_sort, rowid` equals
     `hskBand(band)` for all seven bands — including that the 51 null-rank entries come last;
   - `gloss_fts` has a row for every non-variant entry with at least one gloss token and none for a
     variant;
   - every `meta` key is present, `dict_version` equals `dict.meta.version`, and **no `meta` row
     carries a timestamp**;
   - a row whose `classifiers` column is NULL rebuilds as `[]`, not `undefined` — `Entry.classifiers`
     is `string[]` and is never optional (`lib/types.ts:22-48`), and the deep-equality above is
     where that is discovered if the builder gets it wrong.
5. `pnpm data:verify --sizes` prints the cumulative table above and fails if the finished file
   exceeds a committed budget (set it at 50 MB raw / 18 MB brotli, leaving headroom).
6. A test asserts no Make Me a Hanzi data reaches the `.sqlite`.
7. Re-running `pnpm data` on an unchanged snapshot produces a **byte-identical** file: two
   consecutive builds, `sha256sum` on both, same digest. Nothing in the artifact reads the clock, so
   this is achievable as specified rather than aspirational, and it is the reason `built_at` is not
   in `meta`. If it fails, find the nondeterminism before proceeding. The reason is not a cache key
   — cache keys are filenames (see "Naming") — it is that a reproducible artifact is what makes the
   verifier's result transferable: a `.sqlite` built on a Mac and one built in CI are the same file
   or the difference is a bug.

**What an adversarial review should attack here:** the round-trip test being weaker than
deep-equality; `words.freq` computed with SQL `MAX()` instead of by calling the now-exported
`headwordFreq` (they differ when a jieba frequency is 0); the `char_words` row set as well as its
postings; whether `SCHEMA_VERSION` is actually read from one place; and whether the first commit
really contains no implementation.

---

### D2 — The query layer, part 1: `DictStore` over a `SqlRunner`, in Node

**What it builds.** The two settle-first interfaces and the half of the query layer that is pure
B-tree work: entries by id, HSK bands, hanzi search, pinyin search, reading counts, decomposition.
Runs against the D1 file through `node:sqlite`. No browser, no device.

**Files.**

- `lib/dict/sql.ts`, `lib/dict/store.ts` — **from D1's first commit, unchanged**. If either needs a
  change here, the freeze failed; stop and write it into `HANDOFF.md` rather than editing quietly.
- `lib/dict/sqlite-store.ts` — new. The one implementation of `DictStore`, written entirely against
  `SqlRunner`; it is shared by web and native and knows nothing about either.
- `lib/dict/runners/node.ts` — new. `SqlRunner` over `node:sqlite`, for tests and for any remaining
  server-side use.
- `lib/dict/query/{hanzi,pinyin,entries,hsk}.ts` — new. SQL builders, one per query family.
- `lib/dict/pinyin.ts` — **unchanged**. It is already dependency-free and pure.
- `lib/dict/rank.ts` — created in D1 with `compareEntries`; D2 adds the remaining pure helpers
  (`parseIdList`, `stemToken`, `glossTokens`) moved out of `index.ts`.
- `lib/dict/index.ts` — the pure helpers leave; the `LazyDictIndex` class and the `getDict()`-backed
  accessors stay put until D6, because they are the differential oracle every test below compares
  against. Split rather than mutate, and let `index.ts` die with the routes.
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

**Query shapes.** The interesting ones. **The limits are today's constants, not round numbers**:
`search.ts:86-87` sets `MAX_HANZI_PREFIX_IDS = 400` and `MAX_PINYIN_PREFIX_IDS = 600`, and
`hanziGroups` calls `prefixIds` **once per script** (`search.ts:397-398`), so a hanzi prefix query
admits up to 400 + 400 ids. Latency *measured 2026-09-13 (this plan)*, warm, native SQLite 3.51.2,
on the real file — but read the last column before quoting a number.

| Query | SQL | Measured |
|---|---|---|
| hanzi exact | `WHERE simp = ?1 OR trad = ?1 ORDER BY rowid` | 0.016 ms |
| hanzi prefix (×2, one per script) | `WHERE simp >= ?lo AND simp < ?hi ORDER BY rowid LIMIT 400` | 1.18 ms, measured at LIMIT 200 |
| pinyin exact | `WHERE py_toneless = ? ORDER BY rowid` | 0.020 ms, measured at LIMIT 50 |
| pinyin prefix | `WHERE py_toneless >= ?lo AND py_toneless < ?hi ORDER BY rowid LIMIT 600` | 1.59 ms, measured at LIMIT 50 |
| by id | `WHERE id IN (…50…)` | 0.20 ms |

The three "measured at" notes are honest and matter: those figures were taken while writing this
document, at the limits written down then, and the shipped limits are larger. The range scan sorts
its whole matching range by rowid before the `LIMIT` applies, so the cost should track the range
rather than the limit — *should*, which is a hypothesis, not a measurement. **D2 re-measures all
five at the shipped limits and replaces this table.** Nothing downstream may quote the old numbers.

**Prefix truncation changes, deliberately, and this is the one behavioural diff in D2.** Today's
`prefixIds` (`index.ts:365`) walks the sorted key array from the lower bound and emits **whole key
buckets in lexicographic key order** until `limit` *ids* accumulate. So when a prefix overflows the
cap, today's code keeps the alphabetically-first headwords; `ORDER BY rowid LIMIT n` keeps the *n*
most frequent across all matching keys. The SQL form is better — a learner typing `da` wants 大 and
打, not whatever sorts first — and it is also the only form that does not need a two-step
distinct-keys-then-ids query across the Capacitor bridge. It is a change, not a port, and the
acceptance criteria below are written to expose it rather than absorb it.

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
   `store.entries/hskBand/readingCount` return exactly what today's `getEntries/hskBand/readingCount`
   return from the JSON index. This is a differential test against the old implementation, not a
   golden file — both are available in the same process. The `hskBand` half must include **all
   seven bands in full**, not a sample, because the 51 null-`freqRank` entries are the only rows
   where the two orderings can disagree and six of them are in band 1.
3. `wordsContaining` has **no counterpart in today's code** — `lib/dict/index.ts` exposes
   `getEntry`, `getEntries`, `hskBand`, `readingCount`, `exactIds`, `prefixIds`, `glossIds` and
   `parseIdList`, and none of them answers "which words contain this character". So it gets its own
   criterion with a brute-force oracle instead of a differential one: for a fixed set of at least 20
   characters (including one that appears in only one headword, one of the commonest, and one
   simplified/traditional pair that differ), `store.wordsContaining(ch, {script})` returns exactly
   the entries whose `simp` (or `trad`) contains `ch`, in rowid order, cross-checked by scanning
   `dict.json`.
4. Hanzi and pinyin search sections match the JSON implementation group-for-group and
   order-for-order on a fixed query list including `打`, `打算`, `da`, `dasuan`, `da3suan4`,
   `dǎsuàn`, `wǒmen`, `xian`, `lu:4`, `nu:3`, and one astral-plane headword — **for every query
   whose candidate set falls under the cap**, which is most of them and all of the traps. For a
   query that hits the cap (`打`, `da` and `xian` will), equality is not the criterion and must not
   be asserted: the phase records the diff and one line of justification per query, exactly as D3
   does for gloss search, and the justification is the paragraph above. A capped query whose diff is
   *not* explained by key-order-versus-frequency truncation is a bug.
5. A round-trip-count test asserts the budget in the table above by counting `SqlRunner.query`
   invocations against a spy runner. This is the only defence against per-keystroke bridge chatter,
   and it must fail if someone adds a third call.
6. `pnpm test` and `pnpm lint` pass. No module under `lib/dict/` imports `node:fs` any more except
   `load.ts` and `runners/node.ts`.

---

### D3 — The query layer, part 2: gloss search and the segmenter

**What it builds.** The two pieces the audit flagged as hard, kept apart from D2 because each ends
in a behavioural diff that has to be argued rather than asserted.

**Files.** `lib/dict/query/gloss.ts`, `lib/dict/rank.ts` (the `glossTier` machinery moved out of
`search.ts`), `lib/dict/search.ts` (rewritten as the router over the store), `lib/dict/segment.ts`
(inverted), `packages/ai/retrieve.ts` (new — see below), `tests/unit/dict/{search,segment}.test.ts`
(mechanically rewritten, expected values frozen — see acceptance criterion 1),
`tests/unit/ai/helpers.ts` (re-pointed at the store).

**`packages/ai/retrieve.ts` lands here, not in D6.** `mergedSearch()` and `candidateEntries()`
(`app/api/ask/route.ts:177` and `:198`) depend on `search`, `segment` and `getEntry` and on nothing
about the wire, so they can move to `packages/ai/retrieve.ts` over `DictStore` the moment `search`
and `segment` exist — which is the end of this phase. `packages/ai/` and the ten modules beside it
were created and moved in wave 0 ([wave-zero.md](wave-zero.md) §5), so this file is written into a
directory that already exists and nothing here waits on `backend.md` B1. Leaving them in D6
deadlocks two documents: `backend.md` §4's gate table gates B2 on "`data.md` D2 and D3 … **and D6's
`retrieve.ts`**", while D6 gates on `backend.md`'s contract. Building it here breaks the cycle in
the direction the dependency actually runs. The `GroundContext.segment` mismatch (§3) is resolved
here too, and resolving it is this file's job. **`GroundContext.segment` is synchronous**
(`packages/ai/ground.ts:403`, `lib/ai/ground.ts:403` before wave 0's move) and `DictStore.segment`
is not. The fix is not to make `ground.ts` async — `tests/unit/ai/` encode
its rules and should not be churned. The fix is for `retrieve.ts` to `await store.segment()` for
each rendered phrase up front, build a `Map<string, Token[]>`, and pass
`(text) => map.get(text) ?? []`. `entry` and `readings` resolve the same way, from an awaited batch.
Whether the client or the server calls the model, and what goes on the wire, stays `backend.md`'s.

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
runs on the candidate rows the query below returns and is what makes `plan` rank 打算 above a gloss
that merely mentions planning. So **FTS5 is used as a posting-list store and nothing else** —
precisely the role `index.byGloss` plays today — and the plan is unchanged in substance:

```sql
-- The ranked result path.
SELECT e.rowid, e.glosses FROM gloss_fts f JOIN entries e ON e.rowid = f.rowid
WHERE f.gloss_fts MATCH ?  ORDER BY e.rowid  LIMIT :cap;
```

`ORDER BY e.rowid` is the frequency ordering (§D1), which is exactly the ordering today's posting
lists have and which today's `MAX_GLOSS_CANDIDATES = 5000` slice depends on. Measured: 0.84 ms for
`"plan"`, 0.92 ms for `"to" AND "plan"` — measured selecting rowids only, at `LIMIT 400`; re-measure
with `glosses` in the projection at the shipped cap.

**`:cap` is a decision this phase must make explicitly, and 400 is not it.** Today's pre-ranking pool
is `MAX_GLOSS_CANDIDATES = 5000` per query word (`search.ts:89`, `:426`). A `LIMIT 400` is an order
of magnitude *tighter*, not looser, and it has three visible effects, none of which the earlier
draft of this plan accounted for:

- `glossTier` ranks only what the cap admits, so a low-frequency entry that is a perfect tier-0
  match drops out of a broad query it wins today;
- `SearchResult.total` is computed in `paginate` (`search.ts:528-558`) as the group count across all
  sections, so it becomes a *capped* count and the number under the results changes;
- `nextCursor` paging (`SEARCH_PAGE_SIZE = 50`, `parseCursor` at `search.ts:519`) terminates at the
  cap, so a learner paging a broad query hits an earlier end.

The default is therefore `:cap = 5000`, matching `MAX_GLOSS_CANDIDATES`, which makes this a port
rather than a redesign and leaves `total` and paging where they are. If D2/D3's measurement shows
5,000 rows with their gloss text is too much to move per keystroke — and on the Capacitor bridge it
plausibly is — the phase may lower it, but then it must (a) say what to, (b) say why, and (c) report
the measured effect on `total` and on the group sequence of `da` and `to` paged to the end. A lower
cap chosen silently is the failure mode this paragraph exists to prevent.

**`isGlossToken` gets its own query, at its own limit.** `isGlossToken` (`search.ts:261-271`) scans
`(index.byGloss.get(form) ?? []).slice(0, MAX_GLOSS_CANDIDATES)` and returns true on the *first*
candidate with `glossTier <= 1`. It is the `sun`/`can`/`women`-versus-`shi` rule that decides which
section leads, and it is not the ranked path: sharing a smaller ranked-path cap with it would make
it return false where today it returns true, silently rerouting queries. So it issues its own
statement — same shape, `LIMIT 5000`, matching `MAX_GLOSS_CANDIDATES` exactly — and it must stay in
`rowid` order, because "first candidate that matches" is only meaningful in frequency order. It runs
only for a single Latin token of three or more letters (`/^[a-z']{3,}$/`), so it is not on the path
of a typical multi-word English query. It shares the search batch; it does not add a round trip.

**Building the MATCH string is a security-shaped problem, not a formatting one.** FTS5 has its own
query syntax; an unescaped learner query is an injection. The rule: take the query through the same
`words()`/`lemma()` path `englishGroups` uses today, drop anything not matching `[a-z0-9']+`,
double-quote every term, and join with ` AND `. Never emit a bare `*`, a `^`, a `:` or a multi-word
quoted string.

**Do not add an OR group for irregular plurals.** It is tempting, and it would be a third
behavioural change, not a port. Today's chain is exact and worth tracing once, because it is
counter-intuitive: `englishGroups` (`search.ts:414`) lemmatises the query *first* — `lemmas(query)`
maps `lemma` over each word, and `lemma` is `IRREGULAR[word] ?? stemToken(word)` — and only then
computes `forms = new Set([stemToken(word), lemma(word)])` over the **already-lemmatised** word. For
every `IRREGULAR` key that set collapses to a singleton: `lemmas('women')` → `['woman']`, and
`stemToken('woman') === lemma('woman') === 'woman'`. Meanwhile the index side is `glossTokens`,
which stems with `stemToken` and **not** with `lemma` (`index.ts:237`, `:76-94`), and `stemToken`
strips only `-s`/`-ed`/`-ing` — so a gloss containing the literal word *women* is indexed under
`women`. The net effect today: a query for "women" retrieves glosses containing *woman* and not
glosses containing *women*. Emitting `("women" OR "woman")` would widen that, which may well be an
improvement but is out of this phase's budget of two behavioural changes. Emit exactly
`"woman" AND "who"` — one quoted term per lemmatised query word, `forms` reproduced faithfully.
Record the asymmetry in `HANDOFF.md` as a separate, later question; note while you are there that
the comment above `lemma` at `search.ts:164` ("Applied to the query and to every gloss") is wrong
today, and fixing the comment is not fixing the behaviour.

**Why the index stores pre-stemmed tokens rather than raw glosses.** If the table were
`porter unicode61` over raw gloss text, the build-time stemmer would be Porter and the query-time
stemmer would be `stemToken`/`lemma`, and the two disagree in both directions. Indexing
`glossTokens(gloss)` output under plain `unicode61` makes the tokenizer a whitespace splitter and
keeps one stemmer in the system — the one `cold-start.test.ts` already pins. It also measured
smaller (+2.8 MB against the audit's +4.7 MB). The one wrinkle it creates is the apostrophe:
`glossTokens` keeps `'` inside a token, and `unicode61` would split on it, so the table is declared
`tokenize="unicode61 tokenchars ''''"` — verified working, *measured 2026-09-13 (this plan)*.

**Two behavioural changes will show up in `search.test.ts`.** First, **multi-word recall goes up**:
today's code intersects per-word posting lists that were each truncated to 5,000 *before* the
intersection, so a two-word query can come back empty even when many entries carry both words;
FTS5's AND is an exact intersection and the cap applies after it. Note the precision of that claim —
for a *single*-word query, FTS5 plus `LIMIT 5000` is the same pool today's code has, and recall does
not move at all. Second, `isGlossToken` is now a separate statement (above) rather than a slice of a
shared in-memory posting list; its candidate order and its 5,000-row window are preserved exactly,
and if either drifts the `sun`/`can`/`women`-versus-`shi` routing drifts with it. Do not reorder
that query by relevance. Every test that moves must be justified in the phase's writeup, one line
each; a moved test that cannot be justified is a bug.

**Inverting the segmenter.** STACK §2.5 hard part 5 is right and this is the shape:

```ts
export interface SegmentStats { logTotal: number; maxLen: number }
export interface SegmentInput {
  script: SegmentScript;
  stats: SegmentStats;
  /**
   * word → headword frequency, for every ≤16-char substring of every hanzi run.
   * The UNION of both scripts, with the chosen script winning on collision — see below.
   */
  candidates: ReadonlyMap<string, number>;
  /** Every reading of a chosen word, in rowid order. Filled after the cuts are known. */
  idsFor: (word: string) => readonly EntryId[];
}
export function segmentWith(text: string, input: SegmentInput): SegmentResult;
```

**`candidates` spans both scripts, and this is not an optimisation — a regression case depends on
it.** `segment.ts:157-158` defines `lookup = (word) => primary.get(word) ?? secondary.get(word)`,
where `secondary` is the *other* script's headword map, and `freqOf` then computes `headwordFreq`
over whichever list came back. `segment.test.ts` asserts
`expect(segment('學習', { script: 'simp' }).script).toBe('simp')` — 學習 is a traditional headword,
so with `script: 'simp'` it is found only through that fallback. A
`SELECT … FROM words WHERE script = ? AND word IN (…)` returns nothing for it, the DP falls back to
single characters, and the assertion changes meaning without failing loudly. So the candidate query
is `SELECT script, word, freq FROM words WHERE word IN (…)` across **both** scripts, returning the
`script` column, and the store folds the rows into one map with the chosen script winning ties. The
frequencies come out identical to today's: `words(script,word).freq` *is*
`headwordFreq(index, byScript.get(word))` by D1's construction, for whichever script supplied the
row.

**What survives from `route()`, precisely.** The earlier draft of this plan said `route()` moves
"byte-for-byte unchanged". That is false, and the false version hides the one thing worth checking.
`route()` today is
`route(chars, lookup: (word) => EntryId[] | undefined, freqOf: (ids) => number, stats)` and computes
`Math.log(freqOf(ids))` from the ids `lookup` returned; under `SegmentInput` there are no ids during
the DP — `idsFor` is filled after the cuts are known. The new signature is
`route(chars, freqOf: (word: string) => number | undefined, stats)`, and the loop body's two changes
are mechanical: `const ids = lookup(word)` becomes `const freq = freqOf(word)`, and
`if (!ids && length > 1) continue` becomes `if (freq === undefined && length > 1) continue`. What
must survive **unchanged, and is checkable as a line-level diff of the loop body**: the reverse scan,
`const span = Math.min(stats.maxLen, n - i)`, `const floor = -stats.logTotal` as the unknown-word
weight, `weight = Math.log(freq) - stats.logTotal`, and jieba's `(score, end)` tie-break where a
longer word wins an exact tie. Nothing else in the DP moves.

What else changes is everything that reaches into the index:

- `statsFor()` disappears; `logTotal` is `Math.log(meta.words_total_<script>)` and `maxLen` is
  `meta.max_len_<script>`, both read once at `open()`.
- `detectScript()` reads the `chars` table, which the store loads whole at `open()` (14,625 rows,
  two integers each). Its signature becomes `detectScript(chars: CharTable, text: string)` — the
  same shape as today's `detectScript(index, text)` (`segment.ts:88`), with a 14,625-row map in
  place of the index. It therefore stays **synchronous** and its semantics are unchanged: a
  character is evidence only where the two scripts disagree about it, ties go to simplified.
- The candidate fetch is one `IN (...)` query per call over the distinct ≤16-char substrings of all
  hanzi runs, across both scripts. Measured on a 77-hanzi paragraph: 1,095 distinct substrings,
  **1.37 ms** for the single query — measured single-script; the two-script form returns at most
  twice the rows for the same key list and D3 re-measures. The second round trip fetches entry ids
  for the chosen words only.

**Acceptance criteria.**

1. **`tests/unit/dict/segment.test.ts` keeps every expected value it has, and the criterion is
   checkable by diffing the literals.** The suite cannot pass *unedited* — it contains no `async`
   or `await` anywhere, calls a synchronous `segment(text)` through its `cut()` helper, calls
   `detectScript(index, …)` with a `DictIndex`, and asserts against `getDictIndex().bySimp.get('了')`
   and `getDictIndex().byTrad.get('學習')`, all of which D2 and D3 change. Demanding "unchanged"
   would only produce a suite still pointed at the JSON path, testing nothing this phase built. So
   the rule is: **the file is rewritten mechanically and no expected value changes.** Permitted
   edits — the import block; `async`/`await` on the tests and `cut()`; `store.segment` for
   `segment`; `detectScript(chars, text)` for `detectScript(index, text)`; and the two index oracles
   replaced by the store's own exact-match id list for the same headword (the ids behind
   `store.search('了')`'s exact hanzi group, which D1 guarantees is `bySimp.get('了')` in the same
   order). Forbidden — any change to a string literal, a number or a `toBe`/`toEqual` argument, and
   any case removed or weakened (criterion 2 adds two; nothing goes). Review it as a diff: every
   changed line must be one of the permitted kinds.
   The invariants that must therefore still hold: the cut strings `我/打算/明天/去/北京`,
   `他/有/意见`, `研究/生命/的/起源` and `我/随便/看看`; 中华人民共和国 kept whole;
   把/手表 over 把手/表; the untruncated polyphone `entryIds` for 了 with `le5` and `liao3`; the
   offsets that slice the original string back out; the surrogate-pair case for 𠮟; and the three
   `detectScript` verdicts.
2. Two segmentation assertions are **added**, because the cross-script fallback above is thinly
   covered and the port can break it silently. Today's only case,
   `expect(segment('學習', { script: 'simp' }).script).toBe('simp')`, checks the returned *script*
   and not the cut — yet the cut is what the fallback produces, and a single-script candidate query
   would still return `'simp'` while splitting 學習 into two characters. So: assert that
   `store.segment('學習', { script: 'simp' })` yields one word token `學習`, and add the mirror —
   a simplified-only headword forced to `{ script: 'trad' }` — with the same assertion.
3. `tests/unit/dict/search.test.ts` passes, with a written justification for each assertion that
   changed and a diff count in the phase writeup. Zero unexplained changes.
4. A differential test runs a fixed corpus of ≥200 English queries through both the JSON
   implementation and the store and reports group-set differences; the phase ships the report. The
   corpus must **name** `sun`, `can`, `women`, `shi`, `he` and `ta` as individual routing cases with
   their own assertions on which section leads, rather than leaving them to the aggregate — they are
   the `isGlossToken` rule's own examples and an aggregate diff count will not show a section
   swapping places.
5. A paging test takes two broad queries (`da`, `to`) all the way to the end with `nextCursor` and
   compares the whole group sequence, plus `total` at each page, against the JSON implementation.
   This is what makes a silently lowered gloss cap visible; see the `:cap` discussion above.
6. A fuzz test feeds FTS5-syntax metacharacters (`"`, `*`, `^`, `:`, `NEAR`, `AND`, `(`, unbalanced
   quotes, a 200-char query) through `search()` and asserts no SQLite error is ever raised.
7. A test asserts a phrase query is never constructed, by spying on the MATCH strings. A second spy
   assertion: no MATCH string contains ` OR `, which is the guard against the irregular-plural OR
   group creeping back in.
8. Round-trip budget from D2 still holds for `search` and `segment`. `isGlossToken`'s statement
   rides in the existing search batch and must not raise the count.
9. **`packages/ai/retrieve.ts` is done and proven.** For a fixed list of at least 20 ask-shaped queries
   (English sentences, single English words, hanzi, and a mixed one) the ported `mergedSearch` and
   `candidateEntries` return the same entry sets, in the same order, as `app/api/ask/route.ts:177`
   and `:198` do against the JSON index. `tests/unit/ai/` passes with `GroundContext.segment` fed
   from a pre-awaited `Map<string, Token[]>` and with `ground.ts` itself unmodified — the whole
   point of the resolution above is that `ground.ts` and its rule tests do not churn.

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
   memory at once. **Integrity is not checked with the manifest's SHA-256**, and that is a
   deliberate reversal of an earlier draft: the Web Crypto API's only digest entry point is the
   one-shot `crypto.subtle.digest(alg, data)`, which takes a complete buffer and has no
   update/finalize form, so hashing the download would mean either buffering all 43 MB — defeating
   the reason for the chunked import — or adding a streaming-hash dependency to a phase whose only
   new dependency is `@sqlite.org/sqlite-wasm`. Instead, two cheap checks that between them
   distinguish the two failure modes acceptance criterion 6 requires:
   **truncation** — sum the chunk lengths and compare against the manifest's `bytes` (exact, free,
   `reason: 'download'`); **corruption** — after opening, read `PRAGMA application_id` (must be
   `0x54474D31`), `PRAGMA user_version` (must equal `SCHEMA_VERSION`) and
   `SELECT value FROM meta WHERE key='dict_version'` (must equal the manifest's). Those touch a
   handful of pages and are what D1's magic number exists for. A full `PRAGMA integrity_check` reads
   the entire file; it is run only when a later query raises `SQLITE_CORRUPT`, and D4 measures how
   long it takes in wasm so that decision is informed rather than assumed. The manifest's `sha256`
   stays in the manifest — it is a build- and CI-side fact, and `pnpm data:verify` checks it.
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

**Where the second tab gets its bytes**, because (a) needs 43 MB in the wasm heap and the exclusive
lock means it cannot read them out of the pool — the pool's on-disk layout is the VFS's own opaque
format, not a plain OPFS file the second tab could open. It **re-fetches the artifact**. The
artifact is served with a content-addressed filename and
`Cache-Control: public, max-age=31536000, immutable`, so the browser's HTTP cache should serve it
with zero network bytes — *should*: whether a ~14 MB entry survives in the HTTP cache is not
something any audit established, and it varies by browser and by disk pressure. The alternative,
having the first import also write the response into Cache Storage, is a deliberate second copy of
the artifact on disk (call it +14 to +43 MB depending on whether it is stored encoded) and is **not**
taken for v1: a second tab is a rare case, the failure mode is a slow tab rather than a broken one,
and the on-device footprint discussion below does not budget for it. If measurement in D4 shows the
re-fetch usually reaches the network, revisit. Criterion 5 measures it rather than assuming.

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
5. A second-tab test asserts the fallback, not a hang, **and records how many artifact bytes the
   second tab transferred over the network** — the number goes in the phase writeup next to the
   first tab's, so the paragraph above stops being a guess.
6. The import is exercised once with a deliberately corrupt file — right length, wrong bytes — and
   once with a truncated response. The truncated one must land in `status.failed` with
   `reason: 'download'` (caught by the byte-count check) and the corrupt one with
   `reason: 'corrupt'` (caught by `application_id`/`user_version`/`dict_version`). A third case:
   a file that is a valid SQLite database but not this artifact — also `corrupt`.
7. `PRAGMA integrity_check` on the real 43 MB file in wasm is timed once and the number reported,
   so the "only on `SQLITE_CORRUPT`" rule above is a measured choice.
8. `decomp.json` is fetched only after a decomposition is first requested — asserted by network log.

**Blocked-on-hardware note.** Register #4 — the reported 10 MB per-file OPFS cap in WKWebView — is
**not** answered by this phase, because the container has no Safari. The check is: import the real
43 MB file into `opfs-sahpool` on desktop Safari and on an iPhone. Until someone runs it, the web
dictionary on Apple platforms is unproven, and the fallback if it fails is the in-memory
`sqlite3_deserialize` path (which the same 10 MB claim would not affect) or the bare-table variant
in §7. Do not let this phase claim completion on Safari.

---

### D5a — The native store on Android: the Capacitor plugin runner and the bundled asset

**What it builds.** `SqlRunner` over `@capacitor-community/sqlite`, the first-launch copy, and the
answers to the three register entries an Android phone can settle. **This phase cannot start
without an Android phone** and an `android.md` Capacitor Android project that builds and installs on
it (STACK §4 preconditions). It needs **no Mac and no iOS device** — that is the whole reason it is
a phase of its own, and `android.md` A5 gates on **D5a alone**.

**Files.** `lib/dict/runners/capacitor.ts`, the asset copy step in the Android build (owned jointly
with `android.md`), `data/ATTRIBUTION.md` (SQLCipher's BSD notice).

`lib/dict/runners/capacitor.ts` is platform-neutral: one runner over one plugin API, which D5b then
re-runs this phase's acceptance list against on iOS **without editing it**. It lands here because
Android is the cheaper hardware precondition. If the iOS device happens to arrive first, D5b lands
the file instead and D5a reduces to its Android checks — it is the same file either way and neither
phase gets a second copy.

**The mechanism.** Ship `dict-<schema>-<cedict>.sqlite` as an app asset. On first launch and
whenever the manifest's filename differs from what is in app storage, `copyFromAssets()` it into
app storage and open it **read-only**. The plugin bundles SQLCipher's own SQLite, which is what
makes FTS5 availability independent of the OS SQLite version.

**Budget the file twice.** It sits compressed in the package **and** expanded in app storage after
the copy. Use **~19.5 MB + 43.1 MB ≈ 63 MB**, not the 57 MB an earlier draft gave. The packaged half
is the `gzip -9` figure from D1's size table, because neither an AAB/APK nor an IPA compresses
bundled assets with brotli; the 13.9 MB brotli figure belongs to D4's web transfer budget and
nowhere else. The 19.5 MB is itself a proxy: **STACK register #16** is "Store compression ratio —
the audit used `gzip -9` as a proxy for what the stores actually do", and its check is to read the
real download size in the Play Console and App Store Connect after the first upload. So the packaged
half of this budget is unverified and this plan does depend on #16 for it. This is the single budget
for both platforms: D5b adopts it unchanged, and every size estimate in `ios.md` and `android.md`
must use 63 MB and must carry that caveat.

**Bundling ties dictionary updates to store releases.** That is the trade, stated so it is chosen
rather than discovered. If it ever becomes unacceptable, delivery switches to
download-on-first-launch, which is the same file, the same manifest, the same versioning and the
same `SqlRunner` — only `open()`'s first branch changes.

**Three register entries are settled in this phase, in one device session:**

| # | Question | The check |
|---|---|---|
| 6 | Do `ATTACH` and the `immutable=1` URI flag pass through the plugin? | Call both; read the error. Not fatal either way — two connections work — but it decides whether the dictionary and the learner's database can share a connection. Answered here for Android; D5b confirms it on iOS, because the plugin's two native implementations are different code behind one JS API. |
| 18 | How long does `copyFromAssets()` of a 43 MB file take, and what does it cost in storage? Nobody has measured it. | Time it on the lowest-spec Android target, with the device near-full as well as empty; record peak storage. The iPhone half is D5b's. |
| 5 | Does the plugin ship 16 KB-page-aligned `.so` files? A misaligned one is a Play **rejection**. | `zipalign -c -P 16 -v` on a real AAB. Owned by `android.md`, but it blocks this artifact reaching a store. |

Register **#20** — is FTS5 compiled into the SQLCipher **iOS** pod — is not answerable here and is
**D5b's**. Do not let this phase claim "one file, no per-platform build" on Android evidence alone.

**Batching is the whole performance story here.** Every `SqlRunner.query()` is one JSON round trip
across the bridge (~1–5 ms plus result serialisation). The D2 round-trip test is what keeps a
keystroke at two calls; run it against this runner too. If measurement shows two trips per search is
too many on a real device, the fix is a correlated subquery that fetches candidate headwords and all
their readings in one statement — `WHERE simp IN (SELECT simp FROM entries WHERE simp >= ? AND
simp < ? ORDER BY rowid LIMIT 400)` — not a cache in front of a chatty API. This applies to D5b's
device just as much; it is stated once, here.

**Acceptance criteria.**

1. The same fixed query list from D2/D3/D4 returns identical results through the Capacitor runner on
   a real Android device.
2. Register entries 6, 18's Android half and 5 have written answers with the command and the output.
   A phase that cannot run these because there is no Android phone is **blocked, not complete**.
3. Cold-launch time with the dictionary open is measured on the named low-end Android target (STACK
   §4 requires naming one) and compared against Play's 5 s flag.
4. The first-launch copy is a visible, one-time progress state with a designed low-storage failure
   path — neither exists in any screen today; `core.md` owns drawing them, this phase owns the
   states. They are specified once and D5b checks the same two states on iOS.
5. SQLCipher's BSD notice is in `data/ATTRIBUTION.md` and rendered in the app.
6. `typeof window.speechSynthesis` is logged from the Capacitor Android WebView while a device is in
   hand (register #19, five seconds, belongs to `android.md` but costs nothing here).

---

### D5b — The native store on iOS: FTS5 in the SQLCipher pod

**What it builds.** No new module. It puts D5a's `lib/dict/runners/capacitor.ts` and the bundled
artifact on a physical iPhone, wires the asset copy into the Xcode build, and answers the one
register entry that only Apple hardware can answer. **This phase cannot start without a Mac with
Xcode 26 and a physical iOS 26 device** (STACK §4 preconditions), which is why it is separated from
D5a: nothing on Android's side of the native store should wait on an iPhone.

**Files.** The asset copy step in the iOS build (owned jointly with `ios.md`).
`lib/dict/runners/capacitor.ts` is **D5a's and unchanged here**; if it turns out to need an
iOS-specific branch, that is a finding to write into `HANDOFF.md`, not a refactor to make in this
phase. The 63 MB two-copy budget, the bundling trade and the batching rule are all stated in D5a and
adopted here verbatim.

**Two register entries are settled in this phase, in one device session:**

| # | Question | The check |
|---|---|---|
| 20 | Is FTS5 compiled into the SQLCipher **iOS** pod? Verified for Android only. This is the claim that makes "one file, no per-platform build" true. | Four probes on the copied asset, and the pass mark is **all four returning without error**, not a version comparison — see below. |
| 6, 18 | The iPhone halves of D5a's two cross-platform questions. | `ATTACH` and `immutable=1` called through the iOS plugin; `copyFromAssets()` of the 43 MB file timed on the iPhone, empty and near-full, with peak storage recorded. |

**Register #20's check, spelled out.** The register entry is titled "The SQLite *version* behind the
SQLCipher iOS pod, and therefore whether FTS5 is compiled into it", and reading a version string
only answers it if you know the minimum this artifact needs. The artifact uses four features:
`WITHOUT ROWID` tables, FTS5, `content=''` with `detail=none`, and the unicode61 `tokenchars`
option. **This plan has no verified source for the SQLite release in which each of those landed**
and will not guess one, so the check probes the features directly:

1. `SELECT sqlite_version()` — recorded as diagnosis, so a failure below has a version to blame.
2. `SELECT count(*) FROM words` — exercises `WITHOUT ROWID`.
3. `SELECT count(*) FROM gloss_fts WHERE gloss_fts MATCH '"plan"'` — exercises FTS5, `content=''`
   and `detail=none` together.
4. `SELECT count(*) FROM gloss_fts WHERE gloss_fts MATCH '"one''s"'` — exercises `tokenchars`.

All four succeed, or the entry is answered "no" and the fallback in §6's risk row applies. If the
reported version is at or above the container's **3.51.2**, every feature is known to work there
(*measured 2026-09-13 (this plan)*) and the probes should be a formality; below it, the probes are
the only answer available.

**Acceptance criteria.**

1. The same fixed query list from D2/D3/D4 returns identical results through the Capacitor runner on
   a real iPhone — the same assertions D5a ran on Android, unedited.
2. Register entry 20 has a written answer carrying all four probes' statements and their output, and
   register entries 6 and 18 have their iPhone-side answers. A phase that cannot run these because
   there is no Mac or no iOS 26 device is **blocked, not complete**.
3. Cold-launch time with the dictionary open is measured on the iPhone and reported beside D5a's
   Android figure.
4. The one-time copy progress state and the low-storage failure path D5a specified behave the same
   on iOS.
5. If any of #20's four probes fails, the fallback in §6's risk row is **chosen and written down**
   before the phase closes. "One file everywhere" may not be asserted on the strength of an unrun
   probe.

---

### D6 — Retire the server dictionary

**What it builds.** Nothing. It deletes. Runs last, after `core.md` has re-pointed every consumer
and **`backend.md`'s first B2 commit** has frozen the ask/answer contract — not after all of B2,
which gates on D3 (§4).

**One thing must happen before the first deletion.** D2's and D3's strongest tests are
*differential*: they compare the store against the JSON index in the same process. This phase
deletes that oracle. So the first commit of D6 **freezes those comparisons into golden fixtures**
generated from the JSON implementation while it still exists — the fixed query lists from D2
criteria 2, 3 and 4, D3 criteria 4, 5 and 9, and D1's `words.freq` and `hskBand` orderings —
checked in as data files, with the generator script kept beside them and marked unrunnable after
this phase. A
build session that deletes `LazyDictIndex` first will find the tests pass because there is nothing
left to disagree with.

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
| `lib/dict/decomp.ts` and its `DecompResponse` | replaced by `lib/dict/decomp-store.ts`. `decomp.ts:9` is `import { getDecomp } from './load'`, so it cannot survive `load.ts`. `DecompResponse['characters']` is an anonymous element type today (`{ char: string; entry: DecompEntry \| null }[]`); D1's first commit names it `DecompCharacter[]` in `lib/dict/decomp-store.ts`, which is why it is in the frozen set. |
| `next.config.ts` `outputFileTracingIncludes` | deleted with `next.config.ts` (`web.md`) |
| The `/api/dict/*` **entries** in `scripts/smoke.ts`, `lib/server/route-inventory.ts` and `tests/unit/server/routes.test.ts` | entries removed; the files are `web.md` W2's ([wave-zero.md](wave-zero.md) §3). This phase deletes the five dictionary routes' smoke cases, inventory entries and route assertions, and **leaves all three files in place** — `web.md` W1's dev/preview API adapter imports `discoverApiRoutes()` from the inventory, and W2 decides their final form (smoke rewritten as a dependency-free CLI, the inventory reduced to what the adapter and the coverage check still need, `routes.test.ts` rewritten around the route table and the host config). The guard exists because `/api/examples` and `/api/recall` once shipped untraced and only a human opening the page noticed; **STACK §7 flags that nothing yet replaces "every route is exercised on a built server", and this phase does not close that gap** — W2 does. |
| `tests/e2e/p1/dict-api.spec.ts` | replaced by D4's Playwright store test |
| `data/dict.json` | see below |

**The seven test files nobody else names.** Beyond the `tests/unit/dict/` suites, these import
`@/lib/dict/index` or `@/lib/dict/load` and would break on the deletions above. Each has a stated
fate here so the tail is scoped rather than discovered:

| File | Fate |
|---|---|
| `tests/unit/dict/routes.test.ts` | deleted with the routes it tests. `parseIdList`'s own cases move to a test beside `lib/dict/rank.ts`; `dictVersion` becomes `store.status.version`. |
| `tests/unit/dict/data-required.ts` | kept; D1 already re-pointed it at the manifest and the artifact. |
| `tests/unit/dict/index.test.ts` | split at D2: the pure-helper cases follow `parseIdList`/`stemToken`/`glossTokens` into a `rank.test.ts`; the `LazyDictIndex` cases go here. |
| `tests/unit/data.test.ts` | re-pointed. Its subject is the *generated data*, not the runtime, so its assertions move onto the artifact (via the Node runner) with `dict.json` read directly where the test is about `dict.json`. Its `decomp.json` case is unaffected. |
| `tests/unit/lists/helpers.ts` | re-pointed: `dictEntrySource()` is built over a `DictStore` on the Node runner instead of `getDictIndex`/`getEntries`/`hskBand`. `lib/lists/entry-source.ts` is the consumer `core.md` fixes; this is its test double. |
| `tests/unit/lists/spine.test.ts` | re-pointed at the same helper; it only needs `getDict()` for fixtures. |
| `tests/unit/ai/helpers.ts`, `tests/unit/ai/route.test.ts`, `tests/unit/ai/examples-route.test.ts` | re-pointed **in D3**, not here, with `packages/ai/retrieve.ts`. `entriesFor`/`entryFor` become store calls; `resetDictCache` becomes closing and reopening the store. |
| `tests/unit/server/cold-start.test.ts` | deleted here, but **only because D1 already carries its two load-bearing properties**: `readingKeys`/`normalizePinyin` agreement over every reading and `glossTokens` agreement over every gloss are D1 acceptance criterion 4, re-asserted against the artifact. Its third describe block (the indexes are built one at a time) is about `LazyDictIndex` and dies with it. Do not delete this file before D1's verifier is green. |

**The API contract change nobody should discover at runtime.** `hskBand` gains `limit`/`offset`
because it now crosses a bridge instead of a socket; `lib/lists/entry-source.ts` is the consumer to
fix. Everything else keeps its shape: `SearchResult`, `SegmentResult`, `EntriesResponse.entries` and
`DecompResponse.characters` are the same types, minus the `meta` wrapper, since the version is now
`store.status.version`.

**What this plan owes the three model routes** was **built in D3**, not here: `packages/ai/retrieve.ts`,
the `GroundContext.segment` adapter, and their acceptance criteria are D3's, for the gate reason in
§4. All D6 does about them is delete the server-side originals in `app/api/ask/route.ts` once
`backend.md`'s frozen contract says what replaces the route. The sync/async resolution is **D3**;
"`data.md` §5.7", which earlier drafts of this plan and of `core.md` both cited for it, never
existed and is no longer cited anywhere.

**`data/dict.json`'s fate.** Keep emitting it through D6, because it is the differential-test oracle
for every phase above and it is `verify-data.ts`'s input. Then decide: either `pnpm data` stops
writing it and `verify-data.ts` builds the entry list in memory instead, or it stays as a build
intermediate. Recommendation: keep it as an intermediate — it costs nothing (it is gitignored and
the build is under 10 s) and it is the only thing that can ever answer "did the SQLite build change
the data".

**Acceptance criteria.**

1. `grep -r "api/dict" --include=*.ts --include=*.tsx` returns nothing outside history.
2. No module outside `scripts/`, `tests/`, `lib/server/` and `lib/dict/runners/node.ts` imports
   `node:fs`. The exemptions are exact and there are no others: `lib/server/route-inventory.ts:20`
   imports four `node:fs` functions and is build-side, Node-only and imported by nothing in the app
   (it survives this phase with its `/api/dict/*` entries removed — see the table above), and
   `tests/unit/dict/data-required.ts` needs `existsSync` to produce the "run `pnpm data`" message.
3. The app runs with the network offline from a cold start, once the dictionary is `ready`:
   lookup, search, segmentation of a pasted passage and the character sheet all work.
4. `pnpm test` passes with every suite in the two tables above at its stated fate, and the golden
   fixtures frozen in D6's first commit still match the store. "`pnpm test` passes" on its own is
   not the criterion — a suite that passes because its oracle was deleted also passes.
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
| **FTS5 missing from the SQLCipher iOS pod (#20).** Verified for the Android artifact only. | `CREATE VIRTUAL TABLE … USING fts5` or a `MATCH` fails on iOS. | D5b's device session runs the check. If it fails, "one file everywhere" survives — only English gloss search on iOS breaks — and the fallback is a `LIKE`-based gloss query over `entries.glosses` (slow but correct) or a different plugin. Do not discover this after the schema is frozen. |
| **`copyFromAssets()` of 43 MB is slow or fails on a full device (#18).** Unmeasured by anyone. | First launch hangs, or fails on a device near storage capacity. | Measure in D5a on the lowest-spec Android target and in D5b on the iPhone, empty and near-full. Design the one-time progress state and the low-storage failure path as part of the phase, not after. |
| **WASM query latency is worse than the 2–5× extrapolation (#10).** Nobody measured a browser. | D4's measurement shows an interactive query over ~50 ms. | Measured in D4 against the same seven queries. Levers, in order: fewer round trips (the correlated-subquery form), a smaller `LIMIT`, prepared-statement reuse in the worker, and moving the debounce up. |
| **`ATTACH`/`immutable=1` do not pass through the plugin (#6).** | The call errors on device. | Two connections work; only the query layer's shape changes. Checked in D5a's session and confirmed in D5b's. |
| **Search behaviour drifts during the D3 port.** FTS5's exact AND replaces truncated posting-list intersection, and `isGlossToken`'s candidate order decides which section leads. | `search.test.ts` assertions move, or `sun`/`shi`/`women` route to the wrong section. | The differential test over ≥200 queries in D3, and the rule that every changed assertion carries a one-line justification. `isGlossToken` must inspect candidates in `rowid` order. |
| **The prefix range sentinel drops astral-plane headwords.** Not an audit item; found while writing this plan. | Extension-B headwords stop appearing in prefix search while exact search still works. | Increment the last code point of the prefix; never append `U+FFFF`. No `COLLATE NOCASE`. Unit test in D2 with a real astral headword. |
| **`words.freq` diverges from `headwordFreq()`.** SQL `MAX(freq)` and replaying `compareEntries` differ where a jieba frequency is 0 or absent. | `segment.test.ts` fails on a sentence nobody wrote a case for. | Compute it in TS at build time and assert equality for all 242,087 pairs in `verify-data.ts`. |
| **`node:sqlite` is experimental** and could change across Node minors. | The build script breaks after a Node upgrade. | Pin Node ≥ 22.22 in `engines` (React Router 8 requires it anyway) and keep the builder's SQLite usage to plain `exec`/`prepare`/`run`/`all`. Fallback is `better-sqlite3` as a devDependency; the container has no `sqlite3` CLI, so do not plan on one. |
| **The build is not reproducible**, so a `.sqlite` built on one machine cannot be checked against one built on another and the verifier's result stops transferring. | Two `pnpm data` runs on the same snapshot produce different `sha256sum`s. | D1 acceptance criterion 7. Fixed insert order, **no timestamp anywhere in the file** — `built_at` is not a `meta` row and `builtAt` is not in the manifest, precisely so that this criterion is achievable — and a single final `VACUUM`. Note the filename is not at risk either way: it is `dict-<schema>-<cedict>.sqlite` and contains no hash. |
| **Licence leakage.** `decomp.json` merged into the SQLite file, or the CC BY-SA attribution not shipped with the new artifact. | A `decomposition` column appears; `/settings` stops naming the sources. | D1's test asserting no Make Me a Hanzi data in the `.sqlite`; `meta.sources` carries the same `DictSource[]` the JSON does so `/settings` renders from data; SQLCipher's BSD notice added in D5a. |
| **Bundling couples dictionary updates to store review.** | A CC-CEDICT fix needs a release. | Accepted for v1 and written down. The escape is download-on-first-launch: same file, same manifest, one branch in `open()`. |
| **Store-release size on Android.** ~19.5 MB packaged (`gzip -9` as a proxy — register **#16**) is far under Play's 200 MB base-module cap, but the doubled on-device footprint is ~63 MB. | The Play Console's reported download size after the first upload differs materially from 19.5 MB. | Read the real number off the Play Console and App Store Connect after the first upload and correct `ios.md`, `android.md` and D5a's budget. Until then the packaged half of the 63 MB is unverified. Nothing to *do* about the size itself — the headroom is enormous — but the figure two sibling plans quote rests on #16. |

One item the audits could not verify that this plan **does not** depend on, recorded so nobody
re-opens it here: whether ITP's seven-day eviction reaches WKWebView (**#3**) — the dictionary is a
re-downloadable cache and the learner's data is `core.md`'s and `backend.md`'s problem.

An earlier draft listed the store compression ratio (**#16**) here too. That was wrong: D5a's
on-device budget, which D5b, `ios.md` and `android.md` all adopt, uses `gzip -9` as its proxy for
the packaged half, and #16 is exactly the question of whether that proxy holds. It is in the risk
table above instead.

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
