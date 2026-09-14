/**
 * Builds `data/dict.json` and `data/decomp.json` (PLAN.md §3.1).
 *
 * Run with `pnpm data` (or `pnpm data --force` to re-download). `pnpm build` runs
 * `pnpm data:ensure`, which generates only when `data/dict.json` is missing.
 *
 * Raw downloads are cached so a worktree can rebuild the data in seconds. Every
 * fetch failure is fatal: a half-built dictionary is worse than none, because the
 * routes have a defined answer for missing data (503) and none for wrong data.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  APPLICATION_ID,
  HSK_SORT_SENTINEL,
  MANIFEST_FILE,
  SCHEMA_VERSION,
  artifactFile,
  encodeRowids,
  splitSchema,
  type DictManifest,
} from '../apps/app/lib/dict/artifact';
import { getDictIndex, glossTokens, type DictIndex } from '../apps/app/lib/dict/index';
import { resetDictCache } from '../apps/app/lib/dict/load';
import {
  hasUnknownReading,
  normalizePinyin,
  readingKeys,
  toMarked,
} from '../apps/app/lib/dict/pinyin';
import { headwordFreq, headwordTotals } from '../apps/app/lib/dict/segment';
import { dirOf, workspaceRoot } from '../apps/app/lib/server/roots';

import type { SegmentScript } from '../apps/app/lib/dict/segment';
import type {
  DecompFile,
  DictEntry,
  DictFile,
  DictSource,
  EntryId,
  HskBand,
} from '../apps/app/lib/dict/types';

// The WORKSPACE root: `data/` is generated once here and read by three
// deployables, which is why this script stays at the root rather than moving into
// `apps/app/` (docs/plans/wave-zero.md §1, docs/STACK.md §5). Resolved by marker
// rather than by `..` so that a later move cannot silently relocate the artifact
// while every test still passes (docs/plans/web.md W0).
// `TANGRAM_DATA_DIR` is the authoritative mechanism; this is its safety net.
const repoRoot = workspaceRoot(dirOf(import.meta.url));
// Resolved against the workspace root, not the cwd, so that a relative
// TANGRAM_DATA_DIR means the same directory here as it does to the reader in
// lib/dict/load.ts. There are two cwds in routine use now.
const dataDir = process.env.TANGRAM_DATA_DIR
  ? resolve(repoRoot, process.env.TANGRAM_DATA_DIR)
  : resolve(repoRoot, 'data');
// Raw sources always go in the workspace-local cache PLAN.md §3.1 names, never
// beside the data. They used to go beside it whenever TANGRAM_DATA_DIR was set,
// which was harmless while nothing set it — but the root `data` and
// `data:ensure` scripts now always do, so that branch would put 8.2 MB of
// upstream downloads INSIDE `data/`, which is the directory next.config.ts
// traces wholesale into all eight route bundles. Gitignored either way.
const rawDir = resolve(repoRoot, '.cache/tangram/raw');

const force = process.argv.includes('--force');
const ensure = process.argv.includes('--ensure');

// Where this script would write, printed and nothing else. `tests/unit/workspace.test.ts`
// asks the writer directly rather than re-deriving its arithmetic, because the
// failure mode W0 names is the writer and the reader drifting together.
if (process.argv.includes('--print-data-dir')) {
  process.stdout.write(`${dataDir}\n`);
  process.exit(0);
}

// Whether `--ensure` would consider this tree already built, printed and nothing
// else. Same idea as `--print-data-dir`: the guard is asked by executing it, not
// by re-deriving it in a test, because the failure mode is the guard and the
// build drifting apart. `tests/unit/dict/artifact.test.ts` drives it.
if (process.argv.includes('--print-artifact-status')) {
  process.stdout.write(`${artifactPresent() ? 'present' : 'absent'}\n`);
  process.exit(0);
}

const HSK_URL = 'https://raw.githubusercontent.com/ivankra/hsk30/master/hsk30-expanded.csv';
const JIEBA_URL = 'https://raw.githubusercontent.com/fxsjy/jieba/master/jieba/dict.txt';
const MMH_URL = 'https://raw.githubusercontent.com/skishore/makemeahanzi/master/dictionary.txt';
const MMH_COPYING_URL = 'https://raw.githubusercontent.com/skishore/makemeahanzi/master/COPYING';

/** CJK ideographs (BMP + ext A + compatibility) — enough for dictionary headwords. */
const CJK = /^[㐀-䶿一-鿿豈-﫿]+$/u;

interface CedictRow {
  traditional: string;
  simplified: string;
  pinyin: string;
  english: string[];
}

/** Download once; the cache is what makes `pnpm data` cheap in a fresh worktree. */
async function fetchCached(url: string, filename: string): Promise<string> {
  const path = resolve(rawDir, filename);
  if (existsSync(path) && !force) return readFile(path, 'utf8');
  process.stdout.write(`fetching ${url}\n`);
  let res: Response;
  try {
    res = await fetch(url);
  } catch (cause) {
    throw new Error(`could not reach ${url}: ${(cause as Error).message}`, { cause });
  }
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status} ${res.statusText}`);
  const body = await res.text();
  if (!body.trim()) throw new Error(`${url} returned an empty body`);
  await mkdir(rawDir, { recursive: true });
  await writeFile(path, body, 'utf8');
  return body;
}

const require = createRequire(import.meta.url);

/** The package exports only its entry point, so resolve that and step next door. */
function cedictDir(): string {
  try {
    return dirname(require.resolve('cedict-json'));
  } catch {
    throw new Error('cedict-json is not installed; run pnpm install');
  }
}

function readCedict(): CedictRow[] {
  const jsonPath = resolve(cedictDir(), 'cedict.json');
  if (!existsSync(jsonPath)) throw new Error(`cedict-json has no cedict.json at ${jsonPath}`);
  return require(jsonPath) as CedictRow[];
}

function cedictVersion(): string {
  return (require(resolve(cedictDir(), 'package.json')) as { version: string }).version;
}

function entryId(trad: string, simp: string, pinyinNum: string): EntryId {
  return `${trad}|${simp}[${pinyinNum}]`;
}

/**
 * `CL:個|个[ge4],位[wei4]` → `['个', '位']`. The simplified form is what the app
 * renders, so that is all we keep; the gloss line itself is dropped.
 */
function parseClassifiers(gloss: string): string[] {
  return gloss
    .slice('CL:'.length)
    .split(',')
    .map((ref) => {
      const parts = ref.split('[')[0].split('|');
      return (parts[parts.length - 1] ?? '').trim();
    })
    .filter(Boolean);
}

/** Matches "variant of X", "old variant of X", "nonstandard simplified variant of X", … */
const VARIANT_RE = /^(?:\([^)]*\)\s*)?(?:[A-Za-z]+\s+){0,2}variant of\s+(.+)$/;

/** "variant of 綠|绿[lu:4]" → the id it points at, when the reference is well formed. */
function variantTarget(gloss: string): EntryId | null {
  const ref = VARIANT_RE.exec(gloss)?.[1];
  const m = ref ? /^([^\s[|]+)(?:\|([^\s[]+))?\[([^\]]+)\]/.exec(ref) : null;
  if (!m) return null;
  const [, first, second, pinyin] = m;
  return entryId(first, second ?? first, pinyin);
}

function buildEntries(rows: CedictRow[]): DictEntry[] {
  const entries: DictEntry[] = [];
  const seen = new Set<EntryId>();
  for (const row of rows) {
    const id = entryId(row.traditional, row.simplified, row.pinyin);
    if (seen.has(id)) {
      // The id is the key every card snapshot and every AI citation is written
      // against, so a collision has to stop the build rather than be resolved here.
      throw new Error(`duplicate entry id ${id}`);
    }
    seen.add(id);

    const glosses: string[] = [];
    const classifiers: string[] = [];
    for (const gloss of row.english) {
      // CC-CEDICT writes classifiers two ways: a standalone `CL:…` line, and —
      // newer, and the only form for 83 entries including 山 and 光 — a `(CL:…)`
      // suffix on the sense it belongs to. Both have to come out, or the raw
      // reference is baked into every card snapshot that shows the gloss.
      if (gloss.startsWith('CL:')) {
        classifiers.push(...parseClassifiers(gloss));
        continue;
      }
      const stripped = gloss
        .replace(/\s*\(CL:([^)]*)\)/g, (_, refs: string) => {
          classifiers.push(...parseClassifiers(`CL:${refs}`));
          return '';
        })
        .trim();
      if (stripped) glosses.push(stripped);
    }

    entries.push({
      id,
      simp: row.simplified,
      trad: row.traditional,
      pinyinNum: row.pinyin,
      pinyinMarked: toMarked(row.pinyin),
      glosses,
      // A word can name the same classifier in a standalone line and inline.
      classifiers: [...new Set(classifiers)],
      // CC-CEDICT capitalizes the pinyin of proper nouns. Latin runs such as the `C`
      // of `3C` carry no tone, so requiring a toned syllable keeps them out.
      properNoun: row.pinyin.split(/\s+/).some((s) => /^[A-Z][a-zü:]*[1-5]$/.test(s)),
      isVariant: glosses.length > 0 && glosses.every((g) => VARIANT_RE.test(g)),
      surname: glosses.some((g) => g.startsWith('surname ')),
    });
  }

  // Second pass: a variant may only point at an entry that exists.
  for (const entry of entries) {
    if (!entry.isVariant) continue;
    for (const gloss of entry.glosses) {
      const target = variantTarget(gloss);
      if (target && seen.has(target) && target !== entry.id) {
        entry.variantOf = target;
        break;
      }
    }
  }
  return entries;
}

interface HskRow {
  Simplified: string;
  Pinyin: string;
  POS: string;
  Level: string;
  CEDICT: string;
  Example: string;
}

/** The file is comma-separated with no quoting, so extra commas can only be the last column. */
function parseCsv(text: string): HskRow[] {
  const lines = text.split('\n').filter((line) => line.trim());
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const parts = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((name, i) => {
      row[name] = i === header.length - 1 ? parts.slice(i).join(',') : (parts[i] ?? '');
    });
    return row as unknown as HskRow;
  });
}

function toBand(level: string): HskBand | null {
  if (level === '7-9') return 7;
  const n = Number(level);
  return n >= 1 && n <= 6 ? (n as HskBand) : null;
}

/**
 * jieba supplies frequency only. Its third column is a POS tag, but in a different
 * vocabulary from the HSK list's (`n`/`v`/`nr` against `N`/`V`/`Adj`), and mixing
 * the two would leave `pos` meaning one thing for 8% of entries and another for
 * the rest. `pos` is HSK-only; see HANDOFF.md.
 */
interface JiebaWord {
  freq: number;
  rank: number;
}

function buildFrequency(text: string): Map<string, JiebaWord> {
  const rows: { word: string; freq: number }[] = [];
  for (const line of text.split('\n')) {
    const [word, freq] = line.trim().split(' ');
    if (!word || !CJK.test(word)) continue;
    const n = Number(freq);
    if (!Number.isFinite(n)) continue;
    rows.push({ word, freq: n });
  }
  // Rank 1 = most frequent. Ties break on the word itself so ranks are reproducible.
  rows.sort((a, b) => b.freq - a.freq || (a.word < b.word ? -1 : 1));
  const out = new Map<string, JiebaWord>();
  rows.forEach((row, i) => {
    if (!out.has(row.word)) out.set(row.word, { freq: row.freq, rank: i + 1 });
  });
  return out;
}

interface HskAssignment {
  band: HskBand;
  pos: string;
}

/**
 * Joins the HSK list onto entry ids. The CEDICT column is the intended key and
 * covers almost everything; the fallback matches on the simplified headword,
 * preferring the reading whose pinyin agrees with the HSK row and then the most
 * frequent one. Every fallback is counted and sampled in the output, because a
 * fallback is a guess about which reading the band belongs to.
 */
function joinHsk(
  rows: HskRow[],
  entries: DictEntry[],
  freq: Map<string, JiebaWord>,
): { assignments: Map<EntryId, HskAssignment>; report: string[] } {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const bySimp = new Map<string, DictEntry[]>();
  for (const entry of entries) {
    const list = bySimp.get(entry.simp);
    if (list) list.push(entry);
    else bySimp.set(entry.simp, [entry]);
  }

  const assignments = new Map<EntryId, HskAssignment>();
  const matched = new Map<HskBand, number>();
  const unmatched = new Map<HskBand, number>();
  const unmatchedSamples: string[] = [];
  const fallbackSamples: string[] = [];
  let fallbacks = 0;
  let skippedExamples = 0;

  const assign = (id: EntryId, band: HskBand, pos: string) => {
    const prior = assignments.get(id);
    // A word can be listed twice (two parts of speech, two bands); the lower wins.
    if (!prior || band < prior.band) assignments.set(id, { band, pos });
  };
  const count = (map: Map<HskBand, number>, band: HskBand) => map.set(band, (map.get(band) ?? 0) + 1);

  for (const row of rows) {
    // Rows carrying an Example are illustrative sub-entries, not vocabulary.
    if (row.Example.trim()) {
      skippedExamples += 1;
      continue;
    }
    const band = toBand(row.Level.trim());
    if (!band) continue;

    const cedict = row.CEDICT.trim();
    if (cedict && byId.has(cedict)) {
      assign(cedict, band, row.POS.trim());
      count(matched, band);
      continue;
    }

    const candidates = bySimp.get(row.Simplified.trim()) ?? [];
    if (candidates.length === 0) {
      count(unmatched, band);
      if (unmatchedSamples.length < 5) unmatchedSamples.push(`${row.Simplified} (${row.Pinyin})`);
      continue;
    }
    const want = normalizePinyin(row.Pinyin);
    const agrees = (entry: DictEntry): number => {
      const got = normalizePinyin(entry.pinyinNum);
      if (want.toned && got.toned === want.toned) return 3;
      if (want.toneless && got.toneless === want.toneless) return 2;
      return entry.isVariant || entry.properNoun ? 0 : 1;
    };
    const best = [...candidates].sort(
      (a, b) =>
        agrees(b) - agrees(a) ||
        (freq.get(b.simp)?.freq ?? 0) - (freq.get(a.simp)?.freq ?? 0) ||
        (a.id < b.id ? -1 : 1),
    )[0];
    assign(best.id, band, row.POS.trim());
    count(matched, band);
    fallbacks += 1;
    if (fallbackSamples.length < 8) {
      fallbackSamples.push(`${row.Simplified} (${row.Pinyin}) → ${best.id}`);
    }
  }

  const report: string[] = [];
  for (let band = 1; band <= 7; band += 1) {
    const key = band as HskBand;
    const ok = matched.get(key) ?? 0;
    const no = unmatched.get(key) ?? 0;
    report.push(`  band ${band === 7 ? '7-9' : band}: matched ${ok}, unmatched ${no}`);
    if (ok === 0) throw new Error(`HSK band ${band} joined zero entries — the join is broken`);
  }
  report.push(`  skipped ${skippedExamples} rows carrying an Example`);
  report.push(`  fallback joins (by Simplified, not the CEDICT column): ${fallbacks}`);
  for (const sample of fallbackSamples) report.push(`    e.g. ${sample}`);
  for (const sample of unmatchedSamples) report.push(`    unmatched e.g. ${sample}`);
  return { assignments, report };
}

interface MmhRow {
  character: string;
  definition?: string;
  decomposition?: string;
  radical?: string;
}

function buildDecomp(text: string): DecompFile {
  const out: DecompFile = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as MmhRow;
    if (!row.character || !row.decomposition) continue;
    out[row.character] = {
      decomposition: row.decomposition,
      radical: row.radical ?? '',
      ...(row.definition ? { definition: row.definition } : {}),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// The SQLite artifact (docs/plans/data.md D1)
// ---------------------------------------------------------------------------

/**
 * `data/dict-<schema>-<cedict>.sqlite` — the file every platform queries in
 * place, instead of parsing 35 MB of JSON into a heap on every cold launch.
 *
 * It is built from the `dict.json` this script has just written, read back
 * through `getDictIndex()`. That is deliberate and not a detour: every ordering
 * and every derived value in the artifact is then produced by the *same* code
 * the app uses today — `compareEntries` for rowid order, `headwordFreq` for
 * `words.freq`, `glossTokens` for the FTS text, `readingKeys ?? normalizePinyin`
 * for the two pinyin keys — so `pnpm data:verify` compares the file against the
 * JSON rather than against a second implementation that could be wrong in the
 * same way.
 */

interface SqliteReport {
  manifest: DictManifest;
  lines: string[];
}

/** The two pinyin lookup keys for one entry, or nulls. */
function pinyinColumns(entry: DictEntry): { toneless: string | null; toned: string | null } {
  // `xx5` is CC-CEDICT declaring it has no reading (々, ㍻). `index.ts` skips
  // those rows entirely, so the columns are NULL — which also keeps them out of
  // every range scan for free, and stops a search for `xx` answering with 34
  // unrelated characters.
  if (hasUnknownReading(entry.pinyinNum)) return { toneless: null, toned: null };
  // The identical expression `LazyDictIndex.#buildPinyin` uses. `readingKeys`
  // returns null for the 742 readings that are not plain numbered syllables and
  // those go the slow way; the two agree on every reading in the dictionary and
  // `pnpm data:verify` re-asserts it against the file.
  const keys = readingKeys(entry.pinyinNum) ?? normalizePinyin(entry.pinyinNum);
  return { toneless: keys.toneless || null, toned: keys.toned || null };
}

/** Every gloss token of an entry, deduped across its glosses, in first-seen order. */
function entryGlossTokens(entry: DictEntry): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const gloss of entry.glosses) {
    for (const token of glossTokens(gloss)) {
      if (seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

function insertEntries(db: DatabaseSync, ordered: readonly DictEntry[]): void {
  const statement = db.prepare(
    `INSERT INTO entries (rowid, id, simp, trad, pinyin_num, pinyin_marked, glosses, classifiers,
       py_toneless, py_toned, proper_noun, is_variant, surname, variant_of, pos, hsk_band,
       freq_rank, hsk_sort, freq)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  ordered.forEach((entry, i) => {
    const pinyin = pinyinColumns(entry);
    statement.run(
      i + 1,
      entry.id,
      entry.simp,
      entry.trad,
      entry.pinyinNum,
      entry.pinyinMarked,
      JSON.stringify(entry.glosses),
      // NULL when empty, and it must rebuild as `[]`: `Entry.classifiers` is
      // `string[]` and never optional, so `undefined` would fail the
      // deep-equality round trip on all 124,188 rows.
      entry.classifiers.length > 0 ? JSON.stringify(entry.classifiers) : null,
      pinyin.toneless,
      pinyin.toned,
      Number(entry.properNoun),
      Number(entry.isVariant),
      Number(entry.surname),
      entry.variantOf ?? null,
      entry.pos ?? null,
      entry.hskBand ?? null,
      entry.freqRank ?? null,
      // Only banded rows carry a sort key, and a banded row with no jieba rank
      // gets the sentinel so it sorts last — SQLite puts NULLs first, and six of
      // the 51 rankless banded entries are in HSK 1, the beginner's default band.
      entry.hskBand === undefined ? null : (entry.freqRank ?? HSK_SORT_SENTINEL),
      entry.freq ?? null,
    );
  });
}

function insertGlossFts(db: DatabaseSync, ordered: readonly DictEntry[]): number {
  const statement = db.prepare('INSERT INTO gloss_fts (rowid, text) VALUES (?, ?)');
  let rows = 0;
  ordered.forEach((entry, i) => {
    // Variants carry no meaning of their own ("old variant of X"); indexing them
    // under X's words would put a dead headword in front of the live one, which
    // is exactly what `index.ts` skips them for.
    if (entry.isVariant) return;
    const tokens = entryGlossTokens(entry);
    if (tokens.length === 0) return;
    statement.run(i + 1, tokens.join(' '));
    rows += 1;
  });
  return rows;
}

function insertWords(db: DatabaseSync, index: DictIndex): { simp: number; trad: number } {
  const statement = db.prepare('INSERT INTO words (script, word, freq) VALUES (?, ?, ?)');
  const counts = { simp: 0, trad: 0 };
  for (const script of ['simp', 'trad'] as const) {
    const map = script === 'simp' ? index.bySimp : index.byTrad;
    for (const [word, ids] of map) {
      // `headwordFreq`, called rather than re-derived. SQL `MAX(freq)` gives a
      // different answer wherever a jieba frequency is 0 or absent, and the
      // symptom is a sentence nobody wrote a segmentation case for.
      statement.run(script, word, headwordFreq(index, ids));
      counts[script] += 1;
    }
  }
  return counts;
}

/**
 * `chars` — the per-character facts `detectScript` needs, for every character
 * that is itself a headword in either script. The store reads the whole table at
 * `open()` (14,625 rows, two integers each), which is what keeps `detectScript`
 * synchronous after the port.
 */
function insertChars(db: DatabaseSync, index: DictIndex): number {
  const statement = db.prepare(
    'INSERT INTO chars (ch, simp_evidence, trad_evidence) VALUES (?, ?, ?)',
  );
  const singles: string[] = [];
  const seen = new Set<string>();
  for (const map of [index.bySimp, index.byTrad]) {
    for (const word of map.keys()) {
      if ([...word].length !== 1 || seen.has(word)) continue;
      seen.add(word);
      singles.push(word);
    }
  }
  for (const ch of singles) {
    // A character is evidence only where the two scripts disagree about it —
    // 我 and 的 are written the same way in both and say nothing. This is
    // `detectScript`'s own test, moved to build time.
    const simpEvidence = (index.bySimp.get(ch) ?? []).some(
      (id) => (index.entries.get(id) as DictEntry).trad !== ch,
    );
    const tradEvidence = (index.byTrad.get(ch) ?? []).some(
      (id) => (index.entries.get(id) as DictEntry).simp !== ch,
    );
    statement.run(ch, Number(simpEvidence), Number(tradEvidence));
  }
  return singles.length;
}

/**
 * `char_words` — "which words contain 算", as one packed posting list per
 * (character, script).
 *
 * The domain is every (character, script) pair such that *some headword of that
 * script* contains the character: 11,067 simp + 11,985 trad. That is a larger
 * domain than `chars`, which is keyed on the single-character headwords, and a
 * builder that indexes only single-character headwords produces a table that
 * decodes correctly and is wrong.
 */
function insertCharWords(
  db: DatabaseSync,
  ordered: readonly DictEntry[],
): { rows: number; postings: number } {
  const lists = new Map<string, number[]>();
  let postings = 0;
  ordered.forEach((entry, i) => {
    const rowid = i + 1;
    for (const script of ['simp', 'trad'] as const) {
      const headword = script === 'simp' ? entry.simp : entry.trad;
      // Deduped per headword: 爸爸 contributes one posting for 爸, not two.
      for (const ch of new Set([...headword])) {
        const key = `${script} ${ch}`;
        const list = lists.get(key);
        // Entries are walked in rowid order, so every list is already ascending
        // and `encodeRowids` can store gaps rather than values.
        if (list) list.push(rowid);
        else lists.set(key, [rowid]);
        postings += 1;
      }
    }
  });
  const statement = db.prepare(
    'INSERT INTO char_words (ch, script, n, rowids) VALUES (?, ?, ?, ?)',
  );
  for (const [key, rowids] of lists) {
    const [script, ch] = key.split(' ');
    statement.run(ch, script, rowids.length, encodeRowids(rowids));
  }
  return { rows: lists.size, postings };
}

/**
 * The segmenter's constants, which are constants of the *snapshot* rather than of
 * the code — which is why they are data. `logTotal` is `Math.log()` of
 * `words_total_*`, so the DP's scores stay bit-identical to today's; `max_len_*`
 * keeps `headwordTotals()`'s quirk that a headword longer than `MAX_WORD_CHARS`
 * does not raise it. Both come from `segment.ts` itself rather than from a copy
 * of its loop.
 */
function segmentConstants(index: DictIndex): Record<SegmentScript, { total: number; maxLen: number }> {
  return { simp: headwordTotals(index, 'simp'), trad: headwordTotals(index, 'trad') };
}

function insertMeta(
  db: DatabaseSync,
  dict: DictFile,
  sources: readonly DictSource[],
  entryCount: number,
  words: { simp: number; trad: number },
  constants: Record<SegmentScript, { total: number; maxLen: number }>,
): void {
  const statement = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  const rows: [string, string][] = [
    ['schema_version', String(SCHEMA_VERSION)],
    // The CC-CEDICT snapshot string. It travels onto every card snapshot as
    // `dictVersion`, so its meaning must not change.
    ['dict_version', dict.meta.version],
    // The same `DictSource[]` `dict.json` carries, so `/settings` renders the
    // attribution from the data rather than from a hard-coded list.
    ['sources', JSON.stringify(sources)],
    ['entry_count', String(entryCount)],
    ['words_total_simp', String(constants.simp.total)],
    ['words_total_trad', String(constants.trad.total)],
    ['max_len_simp', String(constants.simp.maxLen)],
    ['max_len_trad', String(constants.trad.maxLen)],
  ];
  // No `built_at`. A wall clock changes the file's bytes and its sha256 on every
  // run, which would make the byte-identity criterion fail on the second build
  // of every clean tree and send a build session hunting a nondeterminism that
  // is its own schema. Provenance is `schema_version` + `dict_version`, both
  // again in the filename, plus the sha256 in the manifest.
  for (const [key, value] of rows) statement.run(key, value);
}

async function buildSqlite(dict: DictFile, sources: readonly DictSource[]): Promise<SqliteReport> {
  const started = Date.now();

  // Read the dictionary back through the app's own loader and indexes. Slower
  // than building from the in-memory array by about a second, and worth it: the
  // artifact is then provably built from what `dict.json` says, which is the
  // property `pnpm data:verify` checks.
  resetDictCache();
  const index = getDictIndex();
  const ordered = [...index.entries.values()];

  const file = artifactFile(dict.meta.version);
  const path = resolve(dataDir, file);
  const temporary = `${path}.tmp-${process.pid}`;
  for (const stale of [temporary, `${temporary}-journal`]) {
    if (existsSync(stale)) await unlink(stale);
  }

  // Resolved against this module, with the same `../apps/app/lib/dict/` arithmetic
  // the imports above use — NOT via `appRoot()`, which walks up for a
  // `package.json` and finds the workspace root's first. If `scripts/` ever
  // moves, this breaks in the same commit as those imports rather than later.
  const schema = readFileSync(new URL('../apps/app/lib/dict/schema.sql', import.meta.url), 'utf8');
  const [tables, indexes] = splitSchema(schema);

  const db = new DatabaseSync(temporary);
  let counts: { words: { simp: number; trad: number }; chars: number; fts: number; charWords: { rows: number; postings: number } };
  try {
    db.exec(tables);
    db.exec('BEGIN');
    insertEntries(db, ordered);
    const fts = insertGlossFts(db, ordered);
    const words = insertWords(db, index);
    const chars = insertChars(db, index);
    const charWords = insertCharWords(db, ordered);
    insertMeta(db, dict, sources, ordered.length, words, segmentConstants(index));
    db.exec('COMMIT');
    // Indexes after the rows, so 124k inserts do not each maintain six live
    // B-trees. One VACUUM at the end, never six — six is what a *measurement*
    // run does, once per row of the size table.
    db.exec(indexes);
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('VACUUM');
    counts = { words, chars, fts, charWords };
  } finally {
    db.close();
  }

  await rename(temporary, path);
  const bytes = statSync(path).size;
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest: DictManifest = {
    file,
    bytes,
    sha256,
    schemaVersion: SCHEMA_VERSION,
    dictVersion: dict.meta.version,
  };
  await writeAtomic(resolve(dataDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));

  return {
    manifest,
    lines: [
      `sqlite ${(bytes / 1e6).toFixed(1)} MB → ${path}`,
      `  entries ${ordered.length}, gloss_fts ${counts.fts}, words ${counts.words.simp + counts.words.trad}` +
        ` (${counts.words.simp} simp + ${counts.words.trad} trad)`,
      `  chars ${counts.chars}, char_words ${counts.charWords.rows} rows holding ${counts.charWords.postings} postings`,
      `  sha256 ${sha256}`,
      `  built in ${((Date.now() - started) / 1000).toFixed(1)} s`,
    ],
  };
}

/**
 * Is the artifact this schema version names actually on disk, whole?
 *
 * `data:ensure` used to test for `dict.json`, and `pnpm build` runs it — so
 * after D1 any tree that already held `dict.json` would never generate the
 * `.sqlite`, and the normal developer path would silently skip this phase's
 * entire output. The guard therefore asks the manifest what the artifact is
 * called and checks that file, its length, and the two JSON inputs the verifier
 * and `decomp.json`'s consumers still need.
 */
function artifactPresent(): boolean {
  const manifestPath = resolve(dataDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return false;
  let manifest: DictManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DictManifest;
  } catch {
    return false;
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) return false;
  if (typeof manifest.file !== 'string' || !manifest.file) return false;
  const artifact = resolve(dataDir, manifest.file);
  if (!existsSync(artifact) || statSync(artifact).size !== manifest.bytes) return false;
  // `dict.json` is still the verifier's oracle and `decomp.json` is a separate
  // artifact under a separate licence; neither is replaced by the `.sqlite`.
  return existsSync(resolve(dataDir, 'dict.json')) && existsSync(resolve(dataDir, 'decomp.json'));
}

/** Write via a temp file: another process may be reading data/ while we rebuild. */
async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
}

async function build(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });

  const [hskCsv, jiebaTxt, mmhTxt, mmhCopying] = await Promise.all([
    fetchCached(HSK_URL, 'hsk30-expanded.csv'),
    fetchCached(JIEBA_URL, 'jieba-dict.txt'),
    fetchCached(MMH_URL, 'makemeahanzi-dictionary.txt'),
    fetchCached(MMH_COPYING_URL, 'makemeahanzi-COPYING'),
  ]);

  const entries = buildEntries(readCedict());

  const freq = buildFrequency(jiebaTxt);
  let freqMatched = 0;
  for (const entry of entries) {
    const hit = freq.get(entry.simp);
    if (!hit) continue;
    entry.freq = hit.freq;
    entry.freqRank = hit.rank;
    freqMatched += 1;
  }

  const { assignments, report } = joinHsk(parseCsv(hskCsv), entries, freq);
  for (const entry of entries) {
    const hsk = assignments.get(entry.id);
    if (!hsk) continue;
    entry.hskBand = hsk.band;
    if (hsk.pos) entry.pos = hsk.pos;
  }

  const sources: DictSource[] = [
    {
      name: 'CC-CEDICT',
      url: `npm:cedict-json@${cedictVersion()}`,
      license: 'CC BY-SA 4.0',
      modifications:
        'Tone-marked pinyin derived mechanically from the numbered pinyin; CL: references (standalone lines and inline "(CL:…)") lifted into classifiers[].',
    },
    { name: 'HSK 3.0 (ivankra/hsk30)', url: HSK_URL, license: 'MIT' },
    { name: 'jieba dictionary', url: JIEBA_URL, license: 'MIT', modifications: 'Word frequencies only; ranked by frequency.' },
    { name: 'Make Me a Hanzi (dictionary.txt)', url: MMH_URL, license: 'LGPL-3.0-or-later' },
  ];
  // What the SQLite artifact actually derives from. Make Me a Hanzi contributes
  // nothing to it — `decomp.json` is a separate file under a separate licence,
  // and that separation is the licence rule (PLAN.md §5, CLAUDE.md). Copying
  // the whole list into `meta.sources` would have the artifact claim an LGPL
  // source it does not contain, which is the opposite of a clean boundary.
  // `data/ATTRIBUTION.md` is committed and covers all three artifacts.
  const sqliteSources = sources.filter((source) => source.url !== MMH_URL);

  const dict: DictFile = {
    meta: { version: cedictVersion(), builtAt: new Date().toISOString(), sources },
    entries,
  };
  const decomp = buildDecomp(mmhTxt);

  await writeAtomic(resolve(dataDir, 'dict.json'), JSON.stringify(dict));
  await writeAtomic(resolve(dataDir, 'decomp.json'), JSON.stringify(decomp));
  // The licence text ships beside the data it covers.
  await writeAtomic(resolve(dataDir, 'COPYING-makemeahanzi'), mmhCopying);

  // `dict.json` keeps being written: it is the differential oracle every phase
  // of docs/plans/data.md compares the store against, and it is
  // `scripts/verify-data.ts`'s input. D6 decides its fate, not this phase.
  const sqlite = await buildSqlite(dict, sqliteSources);

  const banded = entries.filter((entry) => entry.hskBand !== undefined).length;
  process.stdout.write(
    [
      `dict ${entries.length} entries → ${resolve(dataDir, 'dict.json')}`,
      `hsk ${banded} entries banded`,
      ...report,
      `freq ${freqMatched} entries matched from ${freq.size} jieba words`,
      `decomp ${Object.keys(decomp).length} characters → ${resolve(dataDir, 'decomp.json')}`,
      ...sqlite.lines,
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  // The guard tests the artifact the manifest names, never `dict.json`: after
  // D1 a tree that already holds the JSON but no `.sqlite` must still build, or
  // `pnpm build` ships a dictionary-less app and every gate stays green.
  if (ensure && artifactPresent()) {
    process.stdout.write(`data: ${resolve(dataDir, MANIFEST_FILE)} and its artifact present\n`);
    return;
  }
  await build();
}

main().catch((error: unknown) => {
  process.stderr.write(`build-data: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
