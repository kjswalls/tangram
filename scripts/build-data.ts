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
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizePinyin, toMarked } from '../lib/dict/pinyin';
import type {
  DecompFile,
  DictEntry,
  DictFile,
  DictSource,
  EntryId,
  HskBand,
} from '../lib/dict/types';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.TANGRAM_DATA_DIR
  ? resolve(process.env.TANGRAM_DATA_DIR)
  : resolve(repoRoot, 'data');
// Raw sources sit beside the data when TANGRAM_DATA_DIR is set, otherwise in the
// repo-local cache PLAN.md §3.1 names. Both are gitignored.
const rawDir = process.env.TANGRAM_DATA_DIR
  ? resolve(dataDir, 'raw')
  : resolve(repoRoot, '.cache/tangram/raw');

const force = process.argv.includes('--force');
const ensure = process.argv.includes('--ensure');

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

  const dict: DictFile = {
    meta: { version: cedictVersion(), builtAt: new Date().toISOString(), sources },
    entries,
  };
  const decomp = buildDecomp(mmhTxt);

  await writeAtomic(resolve(dataDir, 'dict.json'), JSON.stringify(dict));
  await writeAtomic(resolve(dataDir, 'decomp.json'), JSON.stringify(decomp));
  // The licence text ships beside the data it covers.
  await writeAtomic(resolve(dataDir, 'COPYING-makemeahanzi'), mmhCopying);

  const banded = entries.filter((entry) => entry.hskBand !== undefined).length;
  process.stdout.write(
    [
      `dict ${entries.length} entries → ${resolve(dataDir, 'dict.json')}`,
      `hsk ${banded} entries banded`,
      ...report,
      `freq ${freqMatched} entries matched from ${freq.size} jieba words`,
      `decomp ${Object.keys(decomp).length} characters → ${resolve(dataDir, 'decomp.json')}`,
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  if (ensure && existsSync(resolve(dataDir, 'dict.json'))) {
    process.stdout.write(`data: ${resolve(dataDir, 'dict.json')} present\n`);
    return;
  }
  await build();
}

main().catch((error: unknown) => {
  process.stderr.write(`build-data: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
