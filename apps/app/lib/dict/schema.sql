-- The dictionary artifact's canonical DDL (docs/plans/data.md D1).
--
-- One copy of the schema, read by `scripts/build-data.ts` at build time and by
-- `scripts/verify-data.ts` afterwards, so the builder and the verifier cannot
-- disagree about what they are building and checking. Frozen with `store.ts`
-- and `sql.ts` by D1's first commit; a change here is a `SCHEMA_VERSION` bump
-- in `lib/dict/artifact.ts` and a note in `HANDOFF.md`, not an edit.
--
-- `PRAGMA user_version` (= SCHEMA_VERSION) and `PRAGMA application_id` are
-- deliberately NOT here: they are `lib/dict/artifact.ts` constants, applied by
-- the builder, because the browser and native stores validate an opened file
-- against the same two numbers and a version that lives in two files is a
-- version that drifts. `tests/unit/dict/store-contract.test.ts` asserts this
-- file never assigns either, and pins its text to SCHEMA_VERSION so an edit
-- here cannot land without a deliberate decision about the version number.
--
-- Everything below the index marker near the foot of this file is created
-- AFTER the rows are inserted: the builder splits the file there so 124k
-- inserts do not each maintain six live B-trees. Order is otherwise
-- immaterial — the build ends in one VACUUM.

PRAGMA page_size = 4096;
PRAGMA encoding  = 'UTF-8';

-- One row per CC-CEDICT headword-reading pair.
--
-- `rowid` is assigned in `compareEntries` order (freq DESC, isVariant ASC,
-- properNoun ASC, id ASC), which is the order every existing index already
-- uses. So `ORDER BY rowid` *is* "frequency first, real words before variants
-- before proper nouns, then id", and no query needs the four-clause sort.
CREATE TABLE entries (
  rowid          INTEGER PRIMARY KEY,
  id             TEXT    NOT NULL,   -- 'trad|simp[pinyinNum]'
  simp           TEXT    NOT NULL,
  trad           TEXT    NOT NULL,
  pinyin_num     TEXT    NOT NULL,
  pinyin_marked  TEXT    NOT NULL,
  glosses        TEXT    NOT NULL,   -- JSON array; order is the sense index the AI cites
  classifiers    TEXT,               -- JSON array, NULL when empty — rebuilds as [], never undefined
  py_toneless    TEXT,               -- 'dasuan';  NULL for xx5 readings
  py_toned       TEXT,               -- 'da3suan4'; NULL for xx5 readings
  proper_noun    INTEGER NOT NULL,
  is_variant     INTEGER NOT NULL,
  surname        INTEGER NOT NULL,
  variant_of     TEXT,
  pos            TEXT,
  hsk_band       INTEGER,
  -- freq_rank with NULL folded to a sentinel, for banded rows only. It exists
  -- because hskBand() is the one accessor that does NOT use rowid order:
  -- index.ts re-sorts each band by `freqRank ?? Number.MAX_SAFE_INTEGER`, so the
  -- banded entries with no jieba rank come LAST. SQLite orders NULLs FIRST, so
  -- indexing freq_rank directly would put those at the head of HSK 1 — the
  -- default band, and the one product-decisions §3 sends every beginner to.
  freq_rank      INTEGER,
  hsk_sort       INTEGER,
  freq           INTEGER
);

-- English glosses. Contentless: the text is never read back, only matched.
-- The indexed text is the output of glossTokens() — already stemmed and deduped
-- per gloss — so unicode61 acts as a whitespace splitter and the build-time and
-- query-time stemmers cannot drift. `tokenchars ''''` keeps the apostrophe
-- inside a token ("one's"). is_variant rows are NOT indexed, exactly as
-- index.ts skips them today.
-- `columnsize=0` drops the `gloss_fts_docsize` shadow table, measured at 1.20 MB
-- against this corpus. It is only read by `bm25()` and `columnsize()`, and
-- `bm25()` returns 0 for every row on a contentless `detail=none` table anyway
-- (measured on SQLite 3.51.2 and 3.45.1) — the ranking is `glossTier`, in TS.
CREATE VIRTUAL TABLE gloss_fts USING fts5(
  text,
  content='',
  columnsize=0,
  tokenize="unicode61 tokenchars ''''",
  detail=none
);

-- The segmentation DAG. `freq` is headwordFreq(): the freq of the entry that
-- sorts first for this headword, defaulting to 1. Computed in TypeScript by
-- calling the exported `headwordFreq`, never by SQL MAX() — the two differ
-- wherever a jieba frequency is 0 or absent.
CREATE TABLE words (
  script TEXT    NOT NULL,   -- 'simp' | 'trad'
  word   TEXT    NOT NULL,
  freq   INTEGER NOT NULL,
  PRIMARY KEY (script, word)
) WITHOUT ROWID;

-- Per-character facts, read into memory whole when the store opens. That is
-- what keeps detectScript() synchronous after the port.
-- simp_evidence: some entry has simp = ch and trad <> ch. trad_evidence: the mirror.
CREATE TABLE chars (
  ch            TEXT    NOT NULL PRIMARY KEY,
  simp_evidence INTEGER NOT NULL,
  trad_evidence INTEGER NOT NULL
) WITHOUT ROWID;

-- "Which words contain 算". One row per (character, script) — NOT one per
-- occurrence: the obvious one-row-per-(character, script, entry) shape is 636k
-- rows and +22.4 MB, the packed delta-varint blob is +1.4 MB. The domain is
-- every (character, script) pair such that SOME headword of that script
-- contains the character, which is a larger domain than `chars`.
CREATE TABLE char_words (
  ch          TEXT    NOT NULL,
  script      TEXT    NOT NULL,
  n           INTEGER NOT NULL,
  rowids      BLOB    NOT NULL,   -- delta-varint entries.rowid, ascending
  PRIMARY KEY (ch, script)
) WITHOUT ROWID;

-- Build-time constants and provenance. No timestamp: a wall clock in the file
-- changes its sha256 on every run and makes byte-identity unachievable.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

-- >>> indexes

CREATE UNIQUE INDEX entries_id     ON entries(id);
CREATE INDEX        entries_simp   ON entries(simp);
CREATE INDEX        entries_trad   ON entries(trad);
CREATE INDEX        entries_py_tl  ON entries(py_toneless);
CREATE INDEX        entries_py_td  ON entries(py_toned);
-- Partial: 113,160 of the 124,188 rows have no band, and an unrestricted index
-- stores them all for 1.26 MB. SQLite proves `hsk_band = ?` implies
-- `hsk_band IS NOT NULL` and uses this as a COVERING INDEX for the band query
-- (verified with EXPLAIN QUERY PLAN), so the ordering is still a plain index
-- scan and the implicit rowid tail supplies the `ORDER BY hsk_sort, rowid`
-- tie-break for free.
CREATE INDEX        entries_hsk    ON entries(hsk_band, hsk_sort) WHERE hsk_band IS NOT NULL;
