// @vitest-environment node
/**
 * The worker's cell extractor against the path it replaced, cell for cell.
 *
 * `wasm-extract.ts` reads result cells through raw `capi` calls instead of
 * oo1's `Stmt.get()`, because `get()` costs a BigInt per integer cell and an
 * argument-adapter round per call. That is a speedup only while every value is
 * the same value, so this runs **both** paths — oo1's `get(array)` then
 * `narrow()`, exactly what `runBatch` did before, and the new reader — on the
 * same `sqlite-wasm` 3.53.4 build under Node, and compares:
 *
 *  - **every cell of every table in the real artifact**, FTS5's shadow tables
 *    included (their `block` column is the other BLOB in the file), not a
 *    sample — so every astral headword, every `NULL` classifier and every
 *    `char_words.rowids` posting list is in it;
 *  - the gloss statement `search` sends, since it is the one the change is for;
 *  - edge values the artifact does not happen to hold: the int64 extremes and
 *    both sides of 2^53, an empty and a zero-filled BLOB, text with an embedded
 *    NUL, a leading BOM, invalid and truncated UTF-8, and `-0.0`.
 *
 * "The same" is strict: `Object.is` for scalars, so `-0` is not `0`, and for a
 * BLOB the same bytes in a `Uint8Array` that owns its whole buffer, since that
 * is what oo1 returns and what structured clone then copies.
 *
 * The Playwright parity suite (`tests/e2e/d/dict-wasm.spec.ts`) is the other
 * half: it proves the browser's answers equal `node:sqlite`'s, end to end.
 */
import { readFileSync } from 'node:fs';

import sqlite3InitModule, {
  type Database,
  type Sqlite3Static,
  type SqlValue as WasmSqlValue,
} from '@sqlite.org/sqlite-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { glossCandidates } from '@/lib/dict/query/gloss';
import { narrow, rowReader, type RowReader } from '@/lib/dict/runners/wasm-extract';
import type { SqlValue } from '@/lib/dict/sql';
import { dictArtifactPath } from './data-required';

type Row = Record<string, SqlValue>;

let sqlite3: Sqlite3Static;
let artifact: Database;
let read: RowReader;

/** What `runBatch` did before the extractor: oo1's `get(array)`, then `narrow()`. */
function viaOo1(db: Database, sql: string, params: readonly WasmSqlValue[] = []): Row[] {
  const statement = db.prepare(sql);
  try {
    if (params.length > 0) statement.bind(params as WasmSqlValue[]);
    const columns = statement.getColumnNames();
    const scratch: WasmSqlValue[] = new Array<WasmSqlValue>(columns.length);
    const rows: Row[] = [];
    while (statement.step()) {
      statement.get(scratch);
      const row: Row = {};
      for (let index = 0; index < columns.length; index += 1) {
        row[columns[index]] = narrow(columns[index], scratch[index]);
      }
      rows.push(row);
    }
    return rows;
  } finally {
    statement.finalize();
  }
}

function viaReader(db: Database, sql: string, params: readonly WasmSqlValue[] = []): Row[] {
  const statement = db.prepare(sql);
  try {
    if (params.length > 0) statement.bind(params as WasmSqlValue[]);
    const rows: Row[] = [];
    read(statement, statement.getColumnNames(), rows);
    return rows;
  } finally {
    statement.finalize();
  }
}

/** Why the first differing cell differs, or `null`. Strict about type, sign and buffer. */
function difference(expected: Row[], actual: Row[]): string | null {
  if (expected.length !== actual.length) return `${expected.length} rows, got ${actual.length}`;
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index];
    const got = actual[index];
    const keys = Object.keys(want);
    if (keys.join('\u0000') !== Object.keys(got).join('\u0000')) {
      return `row ${index}: columns ${keys.join(',')} vs ${Object.keys(got).join(',')}`;
    }
    for (const key of keys) {
      const a = want[key];
      const b = got[key];
      if (a instanceof Uint8Array || b instanceof Uint8Array) {
        if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) {
          return `row ${index}.${key}: ${typeof a} vs ${typeof b}`;
        }
        if (Object.getPrototypeOf(b) !== Uint8Array.prototype) {
          return `row ${index}.${key}: not a plain Uint8Array`;
        }
        if (b.byteOffset !== 0 || b.buffer.byteLength !== b.byteLength) {
          return `row ${index}.${key}: a view on a larger buffer`;
        }
        if (a.byteLength !== b.byteLength || a.some((byte, at) => byte !== b[at])) {
          return `row ${index}.${key}: different bytes`;
        }
      } else if (!Object.is(a, b)) {
        return `row ${index}.${key}: ${String(a)} (${typeof a}) vs ${String(b)} (${typeof b})`;
      }
    }
  }
  return null;
}

function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
  return 'did not throw';
}

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
  read = rowReader(sqlite3);
  const file = readFileSync(dictArtifactPath());
  const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
  const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
  artifact = new sqlite3.oo1.DB();
  const rc = sqlite3.capi.sqlite3_deserialize(
    artifact,
    'main',
    pointer,
    bytes.byteLength,
    bytes.byteLength,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_READONLY,
  );
  if (rc !== 0) throw new Error(`sqlite3_deserialize returned ${rc}`);
}, 60_000);

afterAll(() => {
  artifact?.close();
});

describe('the raw cell extractor', () => {
  it('reads every cell of every table in the artifact exactly as oo1 did', () => {
    const tables = viaOo1(
      artifact,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name",
    ).map((row) => row.name as string);
    // The list is asserted, not trusted: a table that silently dropped out of
    // it would be a table this test no longer covers.
    expect(tables).toEqual([
      'char_words',
      'chars',
      'entries',
      'gloss_fts_config',
      'gloss_fts_data',
      'gloss_fts_idx',
      'meta',
      'words',
    ]);
    const seen = { blob: 0, null: 0, astral: 0, integer: 0, text: 0 };
    for (const table of tables) {
      const sql = `SELECT * FROM "${table}"`;
      const expected = viaOo1(artifact, sql);
      const actual = viaReader(artifact, sql);
      expect(difference(expected, actual), table).toBeNull();
      for (const row of expected) {
        for (const value of Object.values(row)) {
          if (value === null) seen.null += 1;
          else if (value instanceof Uint8Array) seen.blob += 1;
          else if (typeof value === 'number') seen.integer += 1;
          else {
            seen.text += 1;
            if (/[\u{20000}-\u{3FFFF}]/u.test(value)) seen.astral += 1;
          }
        }
      }
    }
    // What "every cell" covered, so a regenerated artifact that lost a kind of
    // value is noticed rather than compared vacuously.
    // Measured 2026-09-23: 23,870 BLOBs, 653,531 NULLs, 1,310 astral texts,
    // 993,774 integers and 1,552,795 texts.
    expect(seen.blob).toBeGreaterThan(23_000);
    expect(seen.null).toBeGreaterThan(600_000);
    expect(seen.astral).toBeGreaterThan(1_000);
    expect(seen.integer).toBeGreaterThan(900_000);
    expect(seen.text).toBeGreaterThan(1_500_000);
  }, 120_000);

  it('reads the gloss candidates search sends, for the two over-cap terms', () => {
    for (const term of ['"to"', '"the"']) {
      const { sql, params = [] } = glossCandidates(term);
      const expected = viaOo1(artifact, sql, params as WasmSqlValue[]);
      expect(expected).toHaveLength(5_000);
      expect(difference(expected, viaReader(artifact, sql, params as WasmSqlValue[]))).toBeNull();
    }
  });

  it('agrees with oo1 on the values the artifact does not hold', () => {
    const sql =
      'SELECT 9007199254740991 AS max_safe, -9007199254740991 AS min_safe, ' +
      '2147483648 AS past_int32, -2147483649 AS below_int32, 0 AS zero, ' +
      '1.5 AS real, -0.0 AS negative_zero, 1e308 AS huge_real, 9007199254740993.0 AS real_past_2_53, ' +
      "NULL AS null_value, '' AS empty_text, x'' AS empty_blob, zeroblob(3) AS zeros, " +
      "x'00ff10' AS bytes, '𩽾𧿹' AS astral, 'a' || char(0) || 'b' AS embedded_nul, " +
      "char(65279) || 'x' AS leading_bom, CAST(x'ff80' AS TEXT) AS invalid_utf8, " +
      "CAST(x'f0a9bd' AS TEXT) AS truncated_astral, CAST('12' AS INTEGER) AS cast_int";
    const expected = viaOo1(artifact, sql);
    expect(difference(expected, viaReader(artifact, sql))).toBeNull();
    // And that the comparison had teeth where it matters most.
    expect(expected[0].max_safe).toBe(Number.MAX_SAFE_INTEGER);
    expect(expected[0].past_int32).toBe(2_147_483_648);
    expect(expected[0].astral).toBe('𩽾𧿹');
    expect(expected[0].embedded_nul).toBe('a\u0000b');
  });

  it('agrees row by row when one column changes type between rows', () => {
    const sql =
      "SELECT 1 AS v UNION ALL SELECT 'one' UNION ALL SELECT NULL UNION ALL SELECT x'01' " +
      'UNION ALL SELECT 2.5';
    expect(difference(viaOo1(artifact, sql), viaReader(artifact, sql))).toBeNull();
  });

  it('refuses an integer past 2^53 with the error narrow() gives', () => {
    for (const value of [
      '9007199254740992',
      '-9007199254740992',
      '9223372036854775807',
      '-9223372036854775808',
    ]) {
      const sql = `SELECT ${value} AS big`;
      const expected = thrown(() => viaOo1(artifact, sql));
      expect(expected).toBe(`TypeError: column big does not fit in a JS number: ${value}`);
      expect(thrown(() => viaReader(artifact, sql))).toBe(expected);
    }
  });

  it('hands back a BLOB that survives the next step', () => {
    // A view on the wasm heap would pass a comparison made straight away and
    // then change underneath the caller; this reads every row first.
    const sql = "SELECT rowids FROM char_words WHERE ch IN ('算', '的', '打') ORDER BY ch, script";
    const actual = viaReader(artifact, sql);
    expect(actual.length).toBeGreaterThan(3);
    expect(difference(viaOo1(artifact, sql), actual)).toBeNull();
  });
});
