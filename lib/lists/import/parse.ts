/**
 * Parsers for the list importer (PLAN.md §3.3, lists).
 *
 * Three shapes of pasted text, all of which reduce to "one word per row plus
 * whatever hints the row carries":
 *
 *   plain  — one word per line, hanzi or pinyin; a comma- or tab-separated line
 *            contributes its first cell.
 *   pleco  — Pleco's flashcard text export: `headword<TAB>pinyin<TAB>definition`,
 *            where the headword may be `simp[trad]` and a `//` line names a
 *            category.
 *   anki   — Anki's "Notes in plain text" export: tab-separated fields, optional
 *            `#key:value` header lines, HTML inside fields, quoted fields when a
 *            field carries a tab or a newline. The first note field is the hanzi.
 *
 * Pure functions, no dictionary: resolving the rows is `lib/lists/import/resolve.ts`.
 * `.apkg` is a SQLite database inside a zip and is out of scope — the UI says so.
 */
import { normalizePinyin } from '@/lib/dict/pinyin';

export type ImportFormat = 'plain' | 'pleco' | 'anki';

export interface ImportRow {
  /** 1-based line the row started on, for the preview. */
  line: number;
  /** The row as pasted, trimmed. */
  raw: string;
  /** What to resolve: hanzi in either script, or pinyin. */
  word: string;
  /** The other script, when the row spelled the headword `simp[trad]`. */
  alt?: string;
  /** A reading the row carried — Pleco's second column, or any field that parses as pinyin. */
  pinyin?: string;
  /** The row's own definition, shown beside the dictionary's. */
  definition?: string;
}

export interface ParsedImport {
  format: ImportFormat;
  rows: ImportRow[];
  /** Header, comment and empty lines that were passed over. */
  skipped: number;
}

/** The longest thing that is still plausibly one headword. */
const MAX_WORD_CHARS = 100;

/**
 * A run of CJK ideographs — the range `lib/dict/search.ts`'s `CJK_PATTERN`
 * recognises, spelled again here because that module drags the server-side
 * loader into whatever imports it, and this one runs in the browser.
 */
const CJK_RUN = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2A6DF}\u{2A700}-\u{2EBEF}\u{2F800}-\u{2FA1F}]+/u;

function hasCjk(text: string): boolean {
  return CJK_RUN.test(text);
}

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

/**
 * Split tab-separated records the way Anki writes them: a field that holds a
 * tab, a quote or a newline is wrapped in double quotes, with `""` for a
 * literal quote, so one record can span several lines. Pleco and plain text
 * never quote, and pass through unchanged.
 *
 * Each record remembers the line it began on.
 */
export function splitTabRecords(text: string): { line: number; fields: string[] }[] {
  const records: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  let atFieldStart = true;

  const endRecord = () => {
    fields.push(field);
    records.push({ line: startLine, fields });
    fields = [];
    field = '';
    atFieldStart = true;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
      continue;
    }
    if (ch === '\t') {
      fields.push(field);
      field = '';
      atFieldStart = true;
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      endRecord();
      line += 1;
      startLine = line;
      continue;
    }
    field += ch;
    atFieldStart = false;
  }
  if (field !== '' || fields.length > 0) endRecord();
  return records;
}

// ---------------------------------------------------------------------------
// Cleaning one cell
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** Drop HTML tags, `[sound:…]` references and the entities Anki actually writes. */
export function stripHtml(field: string): string {
  return field
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\[sound:[^\]]*\]/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity)
    .trim();
}

/**
 * `简体[繁體]` (Pleco), and the same with full-width brackets or parentheses, into
 * the two scripts. Only a bracketed part that is itself hanzi counts: `了[le]`
 * is a reading, not a variant, and stays for the pinyin scan.
 */
export function splitHeadword(cell: string): { word: string; alt?: string } {
  const match = /^([^[\]【】（）()]+)[[【（(]\s*([^[\]【】（）()]+?)\s*[\]】）)]/u.exec(cell.trim());
  if (match && hasCjk(match[2]) && !/[a-zA-Z0-9]/.test(match[2])) {
    return { word: match[1].trim(), alt: match[2].trim() };
  }
  return { word: cell.trim() };
}

/**
 * The word a cell contributes: its hanzi run if it has one (`你好 (nǐ hǎo)` is
 * 你好), otherwise the cell as typed for the pinyin path. Empty when there is
 * nothing usable.
 */
export function cleanWord(cell: string): string {
  const text = stripHtml(cell).replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '');
  if (!text) return '';
  if (hasCjk(text)) {
    const run = CJK_RUN.exec(text);
    return run ? run[0].slice(0, MAX_WORD_CHARS) : '';
  }
  // Pinyin (or something that will fail to resolve, which the preview shows).
  return text.replace(/\s+/g, ' ').slice(0, MAX_WORD_CHARS);
}

/** Whether a field is a pinyin reading on its own: `nǐhǎo`, `ni3 hao3`, `le`. */
export function looksLikePinyin(field: string): boolean {
  const text = stripHtml(field);
  if (!text || text.length > 60 || hasCjk(text)) return false;
  return normalizePinyin(text).fullyParsed;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function rowFromFields(
  line: number,
  raw: string,
  fields: string[],
  options: { definitionIndex?: number; pinyinIndex?: number } = {},
): ImportRow | null {
  const head = splitHeadword(stripHtml(fields[0] ?? ''));
  const word = cleanWord(head.word);
  if (!word) return null;

  const row: ImportRow = { line, raw, word };
  if (head.alt) row.alt = head.alt;

  const rest = fields.slice(1).map(stripHtml);
  const pinyinAt =
    options.pinyinIndex !== undefined && looksLikePinyin(rest[options.pinyinIndex - 1] ?? '')
      ? options.pinyinIndex - 1
      : rest.findIndex(looksLikePinyin);
  if (pinyinAt >= 0) row.pinyin = rest[pinyinAt];

  const definitionAt =
    options.definitionIndex !== undefined
      ? options.definitionIndex - 1
      : rest.findIndex((field, i) => i !== pinyinAt && field.length > 0);
  const definition = rest[definitionAt];
  if (definition) row.definition = definition.slice(0, 200);

  return row;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** `#separator:tab`, `#html:true`, `#guid column:1`, … — the Anki export header. */
const ANKI_HEADER = /^#(separator|html|tags|columns|notetype|deck|guid|tags column|notetype column|deck column|guid column)\b/i;

/** `//Category` — Pleco's category marker inside a flashcard export. */
const PLECO_CATEGORY = /^\/\//;

export function detectFormat(text: string): ImportFormat {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines.some((line) => ANKI_HEADER.test(line))) return 'anki';

  const data = lines.filter((line) => line && !PLECO_CATEGORY.test(line));
  if (data.length === 0) return 'plain';

  const tabbed = data.filter((line) => line.includes('\t'));
  const plecoShaped = tabbed.filter((line) => {
    const cells = line.split('\t');
    return cells.length >= 2 && hasCjk(stripHtml(cells[0])) && looksLikePinyin(cells[1]);
  });
  if (plecoShaped.length > 0 && plecoShaped.length * 2 >= data.length) return 'pleco';

  if (/<[a-z][^>]*>/i.test(text) && tabbed.length > 0) return 'anki';
  if (tabbed.length > 0 && tabbed.length * 2 >= data.length) return 'anki';
  return 'plain';
}

// ---------------------------------------------------------------------------
// The three parsers
// ---------------------------------------------------------------------------

/** One word per line; a comma- or tab-separated line contributes its first cell. */
export function parsePlain(text: string): ParsedImport {
  const rows: ImportRow[] = [];
  let skipped = 0;
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const raw = rawLine.trim();
    if (!raw || PLECO_CATEGORY.test(raw) || raw.startsWith('#')) {
      skipped += 1;
      return;
    }
    const fields = raw.split(/\t|,|，|、/).map((cell) => cell.trim());
    const row = rowFromFields(i + 1, raw, fields);
    if (row) rows.push(row);
    else skipped += 1;
  });
  return { format: 'plain', rows, skipped };
}

/** Pleco flashcard export: `headword<TAB>pinyin<TAB>definition`, `//` category lines. */
export function parsePleco(text: string): ParsedImport {
  const rows: ImportRow[] = [];
  let skipped = 0;
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const raw = rawLine.trim();
    if (!raw || PLECO_CATEGORY.test(raw)) {
      skipped += 1;
      return;
    }
    const fields = raw.split('\t').map((cell) => cell.trim());
    const row = rowFromFields(i + 1, raw, fields, { pinyinIndex: 1, definitionIndex: 2 });
    if (row) rows.push(row);
    else skipped += 1;
  });
  return { format: 'pleco', rows, skipped };
}

/**
 * Anki "Notes in plain text": tab-separated fields, HTML inside them, and the
 * optional header block. When the export included the GUID, note type or deck
 * columns, the header says which columns they are and the first *field* comes
 * after them; tags, when included, are the last column and are never a word.
 */
export function parseAnki(text: string): ParsedImport {
  const rows: ImportRow[] = [];
  let skipped = 0;
  let firstField = 0;
  let tagsColumn: number | undefined;

  const records = splitTabRecords(text);
  for (const record of records) {
    const raw = record.fields.join('\t').trim();
    const first = record.fields[0]?.trim() ?? '';
    if (!raw) {
      skipped += 1;
      continue;
    }
    if (ANKI_HEADER.test(first) && record.fields.length === 1) {
      skipped += 1;
      const column = /^#(guid|notetype|deck|tags) column:(\d+)/i.exec(first);
      if (column) {
        const index = Number(column[2]);
        if (column[1].toLowerCase() === 'tags') tagsColumn = index;
        else firstField = Math.max(firstField, index);
      }
      continue;
    }
    let fields = record.fields.slice(firstField);
    if (tagsColumn !== undefined && tagsColumn > firstField) {
      fields = fields.slice(0, tagsColumn - 1 - firstField).concat(fields.slice(tagsColumn - firstField));
    }
    const row = rowFromFields(record.line, raw.replace(/\s+/g, ' ').slice(0, 300), fields);
    if (row) rows.push(row);
    else skipped += 1;
  }
  return { format: 'anki', rows, skipped };
}

/** Detect the shape and parse. */
export function parseImport(text: string): ParsedImport {
  switch (detectFormat(text)) {
    case 'pleco':
      return parsePleco(text);
    case 'anki':
      return parseAnki(text);
    default:
      return parsePlain(text);
  }
}
