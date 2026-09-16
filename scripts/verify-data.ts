/**
 * Proves the SQLite dictionary against the JSON it was built from
 * (docs/plans/data.md D1, acceptance criteria 2 and 4–7).
 *
 * Run with `pnpm data:verify`, or `pnpm data:verify --sizes` to add the size
 * report and the compressed figures.
 *
 * The whole point is that it compares the artifact against **`data/dict.json`
 * parsed in this same process**, not against a golden file and not against a
 * second implementation of the build. Every ordering and every derived value in
 * the file was produced by a function the app also uses — `compareEntries`,
 * `headwordFreq`, `glossTokens`, `readingKeys ?? normalizePinyin`,
 * `detectScript` — so the question this script answers is "did the SQLite build
 * change the data", and it can only answer it while the JSON still exists. D6
 * is what decides `dict.json`'s fate; until then this is the oracle.
 *
 * Exit 0 and a report, or exit 1 and the first few disagreements per check.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

import {
  APPLICATION_ID,
  HSK_SORT_SENTINEL,
  MANIFEST_FILE,
  SCHEMA_VERSION,
  decodeRowids,
  type DictManifest,
} from '../apps/app/lib/dict/artifact';
import {
  detectScript,
  getDict,
  getDictIndex,
  glossTokens,
  headwordFreq,
  headwordTotals,
  hskBand,
  resetDictCache,
} from './dict-json';
import { hasUnknownReading, normalizePinyin, readingKeys } from '../apps/app/lib/dict/pinyin';
import { compareEntries } from '../apps/app/lib/dict/rank';
import { hasCjk } from '../apps/app/lib/dict/search';
import { dirOf, workspaceRoot } from '../apps/app/lib/server/roots';

import type { DictEntry, EntryId, HskBand } from '../apps/app/lib/dict/types';

const repoRoot = workspaceRoot(dirOf(import.meta.url));
const dataDir = process.env.TANGRAM_DATA_DIR
  ? resolve(repoRoot, process.env.TANGRAM_DATA_DIR)
  : resolve(repoRoot, 'data');

const wantSizes = process.argv.includes('--sizes');

/**
 * The committed budget (data.md D1 criterion 5). Headroom over the measured
 * 43.2 MB raw / 15.3 MB brotli q11 — D1's table says 13.9 MB and the real file
 * does not reach it, see HANDOFF.md — because the point of a budget is to catch
 * a schema change that doubles the file, not to fail on a snapshot that grew.
 */
const BUDGET_RAW_BYTES = 50_000_000;
const BUDGET_BROTLI_BYTES = 18_000_000;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

let failures = 0;
const SAMPLES = 5;

function ok(label: string, detail = ''): void {
  process.stdout.write(`  ok    ${label}${detail ? ` — ${detail}` : ''}\n`);
}

function fail(label: string, problems: readonly string[]): void {
  failures += 1;
  process.stdout.write(`  FAIL  ${label} — ${problems.length} problem(s)\n`);
  for (const problem of problems.slice(0, SAMPLES)) process.stdout.write(`          ${problem}\n`);
  if (problems.length > SAMPLES) {
    process.stdout.write(`          … and ${problems.length - SAMPLES} more\n`);
  }
}

/** Report a check whose result is a (possibly empty) list of disagreements. */
function check(label: string, problems: readonly string[], detail = ''): void {
  if (problems.length === 0) ok(label, detail);
  else fail(label, problems);
}

function section(name: string): void {
  process.stdout.write(`\n${name}\n`);
}

// ---------------------------------------------------------------------------
// Row → Entry
// ---------------------------------------------------------------------------

type Row = Record<string, string | number | null | Uint8Array>;

function text(value: Row[string]): string {
  if (typeof value !== 'string') throw new Error(`expected TEXT, got ${typeof value}`);
  return value;
}

function int(value: Row[string]): number {
  if (typeof value !== 'number') throw new Error(`expected INTEGER, got ${typeof value}`);
  return value;
}

/**
 * Rebuild an `Entry` exactly as a store must. The traps are here rather than in
 * the comparison: `classifiers` is `string[]` and never optional, so a NULL
 * column has to become `[]` and not `undefined`; every other nullable column is
 * an *absent* property, because that is what `dict.json` has.
 */
function rowToEntry(row: Row): DictEntry {
  const classifiers = row.classifiers;
  const variantOf = row.variant_of;
  const pos = row.pos;
  const band = row.hsk_band;
  const freqRank = row.freq_rank;
  const freq = row.freq;
  return {
    id: text(row.id),
    simp: text(row.simp),
    trad: text(row.trad),
    pinyinNum: text(row.pinyin_num),
    pinyinMarked: text(row.pinyin_marked),
    glosses: JSON.parse(text(row.glosses)) as string[],
    classifiers: classifiers === null ? [] : (JSON.parse(text(classifiers)) as string[]),
    properNoun: int(row.proper_noun) === 1,
    isVariant: int(row.is_variant) === 1,
    surname: int(row.surname) === 1,
    ...(variantOf === null ? {} : { variantOf: text(variantOf) }),
    ...(pos === null ? {} : { pos: text(pos) }),
    ...(band === null ? {} : { hskBand: int(band) as HskBand }),
    ...(freqRank === null ? {} : { freqRank: int(freqRank) }),
    ...(freq === null ? {} : { freq: int(freq) }),
  };
}

/** Key-order-independent deep equality for a plain JSON value. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

interface Artifact {
  db: DatabaseSync;
  path: string;
  manifest: DictManifest;
}

function openArtifact(): Artifact {
  const manifestPath = resolve(dataDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new Error(`${manifestPath} is missing — run \`pnpm data\``);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DictManifest;
  const path = resolve(dataDir, manifest.file);
  if (!existsSync(path)) throw new Error(`${path} is missing — run \`pnpm data\``);
  return { db: new DatabaseSync(path, { readOnly: true }), path, manifest };
}

function checkManifest({ path, manifest }: Artifact): void {
  section('manifest and file identity (criterion 2)');
  const bytes = statSync(path).size;
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  check('manifest bytes match the file', bytes === manifest.bytes ? [] : [`${manifest.bytes} vs ${bytes}`], `${(bytes / 1e6).toFixed(1)} MB`);
  check('manifest sha256 matches the file', sha256 === manifest.sha256 ? [] : [`${manifest.sha256} vs ${sha256}`], sha256.slice(0, 16));
  check(
    'the filename carries both versions',
    manifest.file === `dict-${manifest.schemaVersion}-${manifest.dictVersion}.sqlite` ? [] : [manifest.file],
    manifest.file,
  );
  check('no builtAt in the manifest', 'builtAt' in manifest ? ['manifest carries a timestamp'] : []);
}

function checkPragmas({ db, manifest }: Artifact): void {
  section('pragmas — what tells a store this is the artifact (criterion 4)');
  const read = (name: string): number => {
    const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
    return Object.values(row)[0];
  };
  check('application_id is TGM1', read('application_id') === APPLICATION_ID ? [] : [String(read('application_id'))]);
  check('user_version is SCHEMA_VERSION', read('user_version') === SCHEMA_VERSION ? [] : [String(read('user_version'))]);
  check('page_size is 4096', read('page_size') === 4096 ? [] : [String(read('page_size'))]);
  check('manifest schemaVersion agrees', manifest.schemaVersion === SCHEMA_VERSION ? [] : [String(manifest.schemaVersion)]);
}

/**
 * Every object `schema.sql` declares is actually in the file, with the options
 * it declares (criterion 4, and the "silently matched nothing" lens).
 *
 * Without this, an artifact built from a schema that lost all six indexes passes
 * every other check in this script and every unit test: the content is
 * identical, only the B-trees are gone, and the symptom is a dictionary that is
 * merely slow. The frozen schema file is the oracle, so a dropped index or a
 * changed FTS5 option is a failure here rather than a discovery on a phone.
 */
function checkSchemaObjects({ db }: Artifact): void {
  section('schema objects — the built file carries what schema.sql declares');
  const schema = readFileSync(new URL('../apps/app/lib/dict/schema.sql', import.meta.url), 'utf8');
  const declared = new Map<string, string>();
  for (const match of schema.matchAll(
    /CREATE\s+(?:VIRTUAL\s+)?(?:UNIQUE\s+)?(TABLE|INDEX)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    declared.set(match[2], match[1].toLowerCase());
  }
  const present = new Map(
    (db.prepare('SELECT name, type FROM sqlite_master').all() as Row[]).map((row) => [
      text(row.name),
      text(row.type),
    ]),
  );
  const missing: string[] = [];
  for (const [name, type] of declared) {
    const got = present.get(name);
    if (got === undefined) missing.push(`${type} ${name} is declared and absent`);
    else if (got !== type) missing.push(`${name} is a ${got}, schema.sql says ${type}`);
  }
  check('every table and index in schema.sql is in the file', missing, `${declared.size} objects`);

  // The FTS5 options decide whether a phrase query errors, whether an apostrophe
  // stays inside a token, and whether the 1.20 MB docsize shadow table exists.
  // SQLite stores the CREATE statement verbatim, so they are readable back out.
  const ftsRow = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'gloss_fts'").get() as
    | Row
    | undefined;
  const ftsSql = ftsRow && typeof ftsRow.sql === 'string' ? ftsRow.sql : '';
  const wanted = ["content=''", 'columnsize=0', 'detail=none', "tokenchars ''''"];
  check(
    'gloss_fts keeps its four declared options',
    wanted.filter((option) => !ftsSql.includes(option)).map((option) => `${option} is gone`),
  );

  // Partial, and partial on the exact predicate. An unrestricted rebuild would
  // still answer every query, 1.15 MB larger, and nothing else would notice.
  const hskRow = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'entries_hsk'").get() as
    | Row
    | undefined;
  const hskSql = hskRow && typeof hskRow.sql === 'string' ? hskRow.sql : '';
  check(
    'entries_hsk is still the partial index',
    /WHERE\s+hsk_band\s+IS\s+NOT\s+NULL/i.test(hskSql) ? [] : [`entries_hsk is ${hskSql || 'absent'}`],
  );

  // A VACUUMed file has no freelist. Free pages are file size nobody is using,
  // and they are also what would make the size report a lie.
  const freelist = Object.values(db.prepare('PRAGMA freelist_count').get() as Row)[0];
  check(
    'the file was VACUUMed — no free pages',
    freelist === 0 ? [] : [`${String(freelist)} free pages`],
  );
}

function checkEntries({ db }: Artifact, ordered: readonly DictEntry[]): void {
  section('entries — count, round trip and rowid order (criterion 4)');
  const rows = db.prepare('SELECT * FROM entries ORDER BY rowid').all() as Row[];
  check(
    'COUNT(*) equals dict.entries.length',
    rows.length === ordered.length ? [] : [`${rows.length} rows vs ${ordered.length} entries`],
    String(rows.length),
  );

  const orderProblems: string[] = [];
  const roundTripProblems: string[] = [];
  const classifierRebuilds: string[] = [];
  const limit = Math.min(rows.length, ordered.length);
  for (let i = 0; i < limit; i += 1) {
    const row = rows[i];
    const expected = ordered[i];
    if (int(row.rowid) !== i + 1) orderProblems.push(`row ${i} has rowid ${String(row.rowid)}`);
    if (text(row.id) !== expected.id) {
      orderProblems.push(`rowid ${i + 1}: ${text(row.id)} where compareEntries says ${expected.id}`);
      continue;
    }
    const rebuilt = rowToEntry(row);
    if (canonical(rebuilt) !== canonical(expected)) {
      roundTripProblems.push(`${expected.id}\n            file ${canonical(rebuilt)}\n            json ${canonical(expected)}`);
    }
    // Called out separately because it is the one round-trip failure that would
    // otherwise look like a typing accident: `Entry.classifiers` is `string[]`
    // and never optional, so a NULL column must rebuild as `[]`.
    if (row.classifiers === null && !Array.isArray(rebuilt.classifiers)) {
      classifierRebuilds.push(expected.id);
    }
  }
  check('rowid order equals compareEntries order', orderProblems);
  check('every entry deep-equals the JSON entry, glosses order included', roundTripProblems, `${limit} rows`);
  check('a NULL classifiers column rebuilds as [], never undefined', classifierRebuilds);
}

function checkPinyinKeys({ db }: Artifact, entries: readonly DictEntry[]): void {
  section('pinyin key columns — cold-start.test.ts’s property, against the file (criterion 4)');
  const index = getDictIndex();
  const rows = db.prepare('SELECT id, py_toneless, py_toned FROM entries').all() as Row[];
  const byId = new Map(rows.map((row) => [text(row.id), row]));

  // Against `LazyDictIndex.#buildPinyin`'s own output, not against a re-run of
  // the expression: the criterion is that the columns equal what the index
  // computes, and the index is right here.
  const problems: string[] = [];
  for (const [field, sorted] of [
    ['py_toneless', index.byPinyinToneless],
    ['py_toned', index.byPinyinToned],
  ] as const) {
    const expected = new Map<EntryId, string>();
    sorted.keys.forEach((key, i) => {
      for (const id of sorted.ids[i]) expected.set(id, key);
    });
    for (const entry of entries) {
      const row = byId.get(entry.id);
      if (!row) continue;
      const got = row[field] === null ? undefined : text(row[field]);
      const want = expected.get(entry.id);
      if (got !== want && problems.length < 50) {
        problems.push(`${entry.id} ${field}: file ${String(got)} vs index ${String(want)}`);
      }
    }
  }
  check('both key columns equal the JSON index’s keys for every entry', problems, `${entries.length} entries`);

  // The fallback expression itself, re-asserted, so a future change to either
  // function fails here rather than in a word that quietly stops being findable.
  const fallbackProblems: string[] = [];
  let fellBack = 0;
  for (const entry of entries) {
    const row = byId.get(entry.id);
    if (!row) continue;
    if (hasUnknownReading(entry.pinyinNum)) {
      if (row.py_toneless !== null || row.py_toned !== null) {
        fallbackProblems.push(`${entry.id}: xx5 reading was indexed`);
      }
      continue;
    }
    const fast = readingKeys(entry.pinyinNum);
    if (fast === null) fellBack += 1;
    const keys = fast ?? normalizePinyin(entry.pinyinNum);
    const wantToneless = keys.toneless || null;
    const wantToned = keys.toned || null;
    if (row.py_toneless !== wantToneless || row.py_toned !== wantToned) {
      if (fallbackProblems.length < 50) fallbackProblems.push(`${entry.id}: ${String(row.py_toneless)}/${String(row.py_toned)} vs ${String(wantToneless)}/${String(wantToned)}`);
    }
  }
  check(
    '`readingKeys() ?? normalizePinyin()` reproduces both columns, xx5 excluded',
    fallbackProblems,
    `${fellBack} readings took the slow path`,
  );
}

function checkWords({ db }: Artifact): void {
  section('words — the segmentation DAG (criterion 4)');
  const index = getDictIndex();
  const rows = db.prepare('SELECT script, word, freq FROM words').all() as Row[];
  const got = new Map(rows.map((row) => [`${text(row.script)} ${text(row.word)}`, int(row.freq)]));

  const problems: string[] = [];
  let pairs = 0;
  for (const script of ['simp', 'trad'] as const) {
    const map = script === 'simp' ? index.bySimp : index.byTrad;
    for (const [word, ids] of map) {
      pairs += 1;
      const key = `${script} ${word}`;
      // `headwordFreq`, called — not SQL MAX(freq), which differs wherever a
      // jieba frequency is 0 or absent.
      const want = headwordFreq(index, ids);
      const have = got.get(key);
      if (have === undefined) problems.push(`${key} is missing`);
      else if (have !== want) problems.push(`${key}: freq ${have} vs headwordFreq ${want}`);
    }
  }
  check('one row per distinct (script, headword)', rows.length === pairs ? [] : [`${rows.length} rows vs ${pairs} pairs`], String(pairs));
  check('freq equals headwordFreq() for every pair', problems);
}

function checkChars({ db }: Artifact): void {
  section('chars — detectScript’s per-character verdict (criterion 4)');
  const index = getDictIndex();
  const rows = db.prepare('SELECT ch, simp_evidence, trad_evidence FROM chars').all() as Row[];
  const got = new Map(rows.map((row) => [text(row.ch), row]));

  const expected = new Set<string>();
  for (const map of [index.bySimp, index.byTrad]) {
    for (const word of map.keys()) if ([...word].length === 1) expected.add(word);
  }

  const problems: string[] = [];
  const verdicts: string[] = [];
  for (const ch of expected) {
    const row = got.get(ch);
    if (!row) {
      problems.push(`${ch} is missing`);
      continue;
    }
    const simpEvidence = (index.bySimp.get(ch) ?? []).some(
      (id) => (index.entries.get(id) as DictEntry).trad !== ch,
    );
    const tradEvidence = (index.byTrad.get(ch) ?? []).some(
      (id) => (index.entries.get(id) as DictEntry).simp !== ch,
    );
    if (int(row.simp_evidence) !== Number(simpEvidence) || int(row.trad_evidence) !== Number(tradEvidence)) {
      problems.push(`${ch}: ${String(row.simp_evidence)}/${String(row.trad_evidence)} vs ${Number(simpEvidence)}/${Number(tradEvidence)}`);
      continue;
    }
    // The verdict a store must reproduce from this table alone, against the
    // verdict `detectScript` gives from the JSON index today. Ties go to
    // simplified, which is the app default.
    //
    // Gated on `hasCjk` because `detectScript` is: it skips any character the
    // CJK pattern does not match, and `CJK_PATTERN` stops at U+2EBEF — it does
    // not cover CJK extension G (U+30000-U+3134A) or H. Twelve single-character
    // headwords in this snapshot are ext-G hanzi carrying real script evidence
    // (𰦭 𰻝 𰻞 𱃲 𱅒 𱇏 𱇩 𱇭 𱉝 𱉵 𱌶 𱌹); the table has correct rows for all twelve and
    // today's code can never consult them. A store applying the same gate
    // behaves identically, so this is not a porting risk — but widening the
    // pattern is a behavioural change to segmentation and routing, out of D1's
    // scope and beyond D2/D3's stated budget of two. See HANDOFF.md, D1.
    if (!hasCjk(ch)) continue;
    const fromTable = int(row.trad_evidence) > int(row.simp_evidence) ? 'trad' : 'simp';
    if (fromTable !== detectScript(index, ch)) verdicts.push(`${ch}: table says ${fromTable}`);
  }
  check('a row for every single-character headword', problems, String(expected.size));
  check('the table reproduces detectScript’s verdict character by character', verdicts);
  check('and no rows beyond them', rows.length === expected.size ? [] : [`${rows.length} rows vs ${expected.size} characters`]);
}

function checkCharWords({ db }: Artifact, ordered: readonly DictEntry[]): void {
  section('char_words — the packed posting lists (criterion 4)');
  // The domain is every (character, script) pair such that SOME headword of that
  // script contains the character — a larger domain than `chars`, which is keyed
  // on the single-character headwords. A builder that indexes only
  // single-character headwords produces a table that decodes correctly and is
  // wrong, so the row set is checked separately from the postings.
  const expected = new Map<string, number[]>();
  ordered.forEach((entry, i) => {
    for (const script of ['simp', 'trad'] as const) {
      const headword = script === 'simp' ? entry.simp : entry.trad;
      for (const ch of new Set([...headword])) {
        const key = `${script} ${ch}`;
        const list = expected.get(key);
        if (list) list.push(i + 1);
        else expected.set(key, [i + 1]);
      }
    }
  });

  const rows = db.prepare('SELECT ch, script, n, rowids FROM char_words').all() as Row[];
  const got = new Map(rows.map((row) => [`${text(row.script)} ${text(row.ch)}`, row]));

  const missing: string[] = [];
  const extra: string[] = [];
  for (const key of expected.keys()) if (!got.has(key)) missing.push(key);
  for (const key of got.keys()) if (!expected.has(key)) extra.push(key);
  check('exactly the (character, script) pairs some headword of that script contains', [...missing, ...extra], `${expected.size} rows`);

  const problems: string[] = [];
  let postings = 0;
  for (const [key, want] of expected) {
    const row = got.get(key);
    if (!row) continue;
    postings += want.length;
    if (int(row.n) !== want.length) {
      problems.push(`${key}: n ${String(row.n)} vs ${want.length}`);
      continue;
    }
    const blob = row.rowids;
    if (!(blob instanceof Uint8Array)) {
      problems.push(`${key}: rowids is not a BLOB`);
      continue;
    }
    const decoded = decodeRowids(blob);
    if (decoded.length !== want.length || decoded.some((rowid, i) => rowid !== want[i])) {
      if (problems.length < 50) problems.push(`${key}: postings differ`);
    }
  }
  check('every posting list decodes to the right rowids, ascending', problems, `${postings} postings`);
}

function checkHsk({ db }: Artifact, entries: readonly DictEntry[]): void {
  section('HSK — the one query that does not order by rowid (criterion 4)');
  const rows = db.prepare('SELECT id, hsk_band, freq_rank, hsk_sort FROM entries').all() as Row[];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  const problems: string[] = [];
  let sentinels = 0;
  for (const row of rows) {
    const entry = byId.get(text(row.id));
    if (!entry) continue;
    if (entry.hskBand === undefined) {
      if (row.hsk_sort !== null) problems.push(`${entry.id}: unbanded row has hsk_sort`);
      continue;
    }
    const want = entry.freqRank ?? HSK_SORT_SENTINEL;
    if (entry.freqRank === undefined) sentinels += 1;
    if (row.hsk_sort !== want) problems.push(`${entry.id}: hsk_sort ${String(row.hsk_sort)} vs ${want}`);
  }
  check('hsk_sort is freq_rank ?? sentinel for banded rows, NULL otherwise', problems, `${sentinels} sentinels`);

  const order = db.prepare(
    'SELECT id FROM entries WHERE hsk_band = ? ORDER BY hsk_sort, rowid',
  );
  const orderProblems: string[] = [];
  for (const band of [1, 2, 3, 4, 5, 6, 7] as HskBand[]) {
    const fromFile = (order.all(band) as Row[]).map((row) => text(row.id));
    const fromJson = hskBand(band).map((entry) => entry.id);
    if (fromFile.length !== fromJson.length) {
      orderProblems.push(`band ${band}: ${fromFile.length} vs ${fromJson.length}`);
      continue;
    }
    const at = fromFile.findIndex((id, i) => id !== fromJson[i]);
    if (at !== -1) orderProblems.push(`band ${band} diverges at ${at}: ${fromFile[at]} vs ${fromJson[at]}`);
  }
  // All seven bands in full, not a sample: the 51 rankless entries are the only
  // rows where the two orderings can disagree, and six of them are in band 1.
  check('ORDER BY hsk_sort, rowid equals hskBand() for all seven bands', orderProblems);
}

function checkGlossFts({ db }: Artifact, ordered: readonly DictEntry[]): void {
  section('gloss_fts — the posting-list store (criterion 4)');
  // A contentless FTS5 table cannot be scanned, so the index is read the only
  // way it can be: one MATCH per distinct token. That is also the strongest
  // check available — it verifies the postings themselves, not just how many
  // rows went in.
  const wanted = new Map<string, number[]>();
  const expectedRows = new Set<number>();
  const variants: string[] = [];
  ordered.forEach((entry, i) => {
    const rowid = i + 1;
    if (entry.isVariant) return;
    const tokens = new Set<string>();
    for (const gloss of entry.glosses) for (const token of glossTokens(gloss)) tokens.add(token);
    if (tokens.size === 0) return;
    expectedRows.add(rowid);
    for (const token of tokens) {
      const list = wanted.get(token);
      if (list) list.push(rowid);
      else wanted.set(token, [rowid]);
    }
  });

  const match = db.prepare('SELECT rowid FROM gloss_fts WHERE gloss_fts MATCH ? ORDER BY rowid');
  const problems: string[] = [];
  const seenRows = new Set<number>();
  for (const [token, want] of wanted) {
    const got = (match.all(`"${token.replace(/"/g, '""')}"`) as Row[]).map((row) => int(row.rowid));
    for (const rowid of got) seenRows.add(rowid);
    if (got.length !== want.length || got.some((rowid, i) => rowid !== want[i])) {
      if (problems.length < 50) problems.push(`token ${token}: ${got.length} rows vs ${want.length}`);
    }
  }
  // "the JSON index's" up to one difference that is deliberate and is D3's to
  // account for: `index.byGloss` pushes an id once PER GLOSS, so a posting list
  // there can carry the same id several times, while an FTS5 index carries a
  // rowid once per term. The comparison above is against the DEDUPED expansion
  // of `byGloss`, which is what the artifact can represent. Where it bites is
  // the 5,000-candidate slice: for a handful of very common tokens the JSON
  // slice spends places on duplicates and the FTS one does not, so the two
  // candidate pools differ at the cap. See HANDOFF.md.
  check('every gloss token’s posting list equals the deduped JSON posting list', problems, `${wanted.size} tokens`);

  for (const rowid of seenRows) {
    if (!expectedRows.has(rowid)) variants.push(`rowid ${rowid} is indexed and should not be`);
  }
  check(
    'a row for every non-variant entry with a token, and none for a variant',
    variants,
    `${expectedRows.size} rows`,
  );
}

function checkMeta({ db }: Artifact, ordered: readonly DictEntry[]): void {
  section('meta — the constants that are properties of the snapshot (criterion 4)');
  const index = getDictIndex();
  const rows = db.prepare('SELECT key, value FROM meta').all() as Row[];
  const meta = new Map(rows.map((row) => [text(row.key), text(row.value)]));

  const required = [
    'schema_version',
    'dict_version',
    'sources',
    'entry_count',
    'words_total_simp',
    'words_total_trad',
    'max_len_simp',
    'max_len_trad',
  ];
  check('every required key is present', required.filter((key) => !meta.has(key)));
  check(
    'dict_version equals dict.meta.version',
    meta.get('dict_version') === getDict().meta.version ? [] : [`${String(meta.get('dict_version'))} vs ${getDict().meta.version}`],
    String(meta.get('dict_version')),
  );
  check(
    'entry_count equals the row count',
    meta.get('entry_count') === String(ordered.length) ? [] : [String(meta.get('entry_count'))],
  );

  // The segmenter's constants: the client takes Math.log() of words_total_*, so
  // the DP's scores are bit-identical to today's only if these are exact. Read
  // from `segment.ts`'s own exported `headwordTotals`, not from a copy of its
  // loop — a verifier that re-implements what it verifies cannot see drift.
  const constantProblems: string[] = [];
  for (const script of ['simp', 'trad'] as const) {
    const { total, maxLen } = headwordTotals(index, script);
    if (meta.get(`words_total_${script}`) !== String(total)) {
      constantProblems.push(`words_total_${script}: ${String(meta.get(`words_total_${script}`))} vs ${total}`);
    }
    if (meta.get(`max_len_${script}`) !== String(maxLen)) {
      constantProblems.push(`max_len_${script}: ${String(meta.get(`max_len_${script}`))} vs ${maxLen}`);
    }
  }
  check("statsFor()'s two constants per script", constantProblems, `${meta.get('words_total_simp')}/${meta.get('max_len_simp')} simp`);

  // No clock anywhere in the file: that is what makes byte-identity achievable,
  // and it is why `built_at` is not a meta row.
  const stamps = rows
    .filter(
      (row) =>
        /built|timestamp|_at$/.test(text(row.key)) ||
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text(row.value)),
    )
    .map((row) => text(row.key));
  check('no meta row carries a timestamp', stamps);
}

/**
 * The licence boundary, as an assertion rather than a convention
 * (criterion 6; CLAUDE.md "Data and licences", PLAN.md §5).
 *
 * Make Me a Hanzi is LGPL-3.0-or-later and CC-CEDICT is CC BY-SA 4.0. Keeping
 * `decomp.json` a separate artifact is the whole mechanism that stops the two
 * merging, so "no decomposition data in the `.sqlite`" has to be checkable, not
 * asserted in a comment.
 */
function checkLicenceBoundary({ db, path }: Artifact): void {
  section('licence boundary — no Make Me a Hanzi data in the artifact (criterion 6)');
  const schema = (db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all() as Row[])
    .map((row) => text(row.sql))
    .join('\n');
  check(
    'no table or column is named for a decomposition fact',
    /decomp|radical|stroke|makemeahanzi/i.test(schema) ? ['a decomposition-shaped name is in the schema'] : [],
  );

  const sources = db.prepare("SELECT value FROM meta WHERE key = 'sources'").get() as Row | undefined;
  const sourcesText = sources ? text(sources.value) : '';
  check(
    'meta.sources names only the sources this file actually derives from',
    /makemeahanzi|Make Me a Hanzi/i.test(sourcesText) ? ['Make Me a Hanzi is listed as a source of the SQLite dictionary'] : [],
    `${(JSON.parse(sourcesText || '[]') as { name: string }[]).map((s) => s.name).join(', ')}`,
  );

  // The decomposition strings themselves. An IDS string is unmistakable —
  // ⿰⿱⿲⿳ and friends are a Unicode block of their own and appear nowhere in
  // CC-CEDICT — so their absence from the raw bytes is a complete check.
  const bytes = readFileSync(path).toString('utf8');
  const ids = [...'⿰⿱⿲⿳⿴⿵⿶⿷⿸⿹⿺⿻'].filter((ch) => bytes.includes(ch));
  check('no IDS decomposition character appears anywhere in the file', ids.map((ch) => `found ${ch}`));
}

// ---------------------------------------------------------------------------
// The size report (criterion 5)
// ---------------------------------------------------------------------------

/**
 * `--sizes`. The plan's table was produced by seven separate builds, one per
 * candidate layout; this is the same information read off the shipped file with
 * `dbstat`, which is cheaper by seven builds and strictly more detailed. After
 * a VACUUM the freelist is empty, so the per-object page bytes sum to the file.
 */
function sizeReport({ db, path }: Artifact): void {
  section('size report (criterion 5)');
  let stats: Row[];
  try {
    stats = db.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all() as Row[];
  } catch (error) {
    process.stdout.write(`  dbstat is unavailable (${(error as Error).message}); reporting the total only\n`);
    stats = [];
  }
  const bytesFor = new Map(stats.map((row) => [text(row.name), int(row.bytes)]));
  const groups: [string, string[]][] = [
    ['entries + unique id index', ['entries', 'entries_id']],
    ['+ entries_simp, entries_trad', ['entries_simp', 'entries_trad']],
    ['+ pinyin key indexes', ['entries_py_tl', 'entries_py_td']],
    ['+ entries_hsk (partial)', ['entries_hsk']],
    ['+ gloss_fts', ['gloss_fts_data', 'gloss_fts_idx', 'gloss_fts_config', 'gloss_fts_docsize']],
    ['+ words', ['words']],
    ['+ char_words', ['char_words']],
    ['+ chars, meta, schema', ['chars', 'meta', 'sqlite_schema']],
  ];
  let cumulative = 0;
  for (const [label, names] of groups) {
    cumulative += names.reduce((sum, name) => sum + (bytesFor.get(name) ?? 0), 0);
    process.stdout.write(`  ${(cumulative / 1e6).toFixed(1).padStart(6)} MB  ${label}\n`);
  }

  const raw = readFileSync(path);
  const gzip = gzipSync(raw, { level: 9 }).length;
  const brotli = brotliCompressSync(raw, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length },
  }).length;
  process.stdout.write(
    `  ${(raw.length / 1e6).toFixed(1)} MB raw · ${(gzip / 1e6).toFixed(1)} MB gzip -9 · ${(brotli / 1e6).toFixed(1)} MB brotli q11\n`,
  );
  check('raw size is within budget', raw.length <= BUDGET_RAW_BYTES ? [] : [`${raw.length} > ${BUDGET_RAW_BYTES}`]);
  check('brotli size is within budget', brotli <= BUDGET_BROTLI_BYTES ? [] : [`${brotli} > ${BUDGET_BROTLI_BYTES}`]);
}

// ---------------------------------------------------------------------------

function main(): void {
  resetDictCache();
  const dict = getDict();
  // Sorted here rather than taken from the index, so the rowid-order check has
  // an oracle that does not share the index's construction.
  const ordered = [...dict.entries].sort(compareEntries);
  const artifact = openArtifact();

  process.stdout.write(`verifying ${artifact.path}\n  against ${resolve(dataDir, 'dict.json')} (${dict.entries.length} entries)\n`);
  try {
    checkManifest(artifact);
    checkPragmas(artifact);
    checkSchemaObjects(artifact);
    checkEntries(artifact, ordered);
    checkPinyinKeys(artifact, dict.entries);
    checkWords(artifact);
    checkChars(artifact);
    checkCharWords(artifact, ordered);
    checkHsk(artifact, dict.entries);
    checkGlossFts(artifact, ordered);
    checkMeta(artifact, ordered);
    checkLicenceBoundary(artifact);
    const raw = statSync(artifact.path).size;
    if (wantSizes) sizeReport(artifact);
    else {
      section('size (criterion 5 — `--sizes` adds the table and the compressed figures)');
      check('raw size is within budget', raw <= BUDGET_RAW_BYTES ? [] : [`${raw} > ${BUDGET_RAW_BYTES}`], `${(raw / 1e6).toFixed(1)} MB of ${BUDGET_RAW_BYTES / 1e6} MB`);
    }
  } finally {
    artifact.db.close();
  }

  process.stdout.write(failures === 0 ? '\nverify-data: all checks passed\n' : `\nverify-data: ${failures} check(s) FAILED\n`);
  if (failures > 0) process.exit(1);
}

main();
