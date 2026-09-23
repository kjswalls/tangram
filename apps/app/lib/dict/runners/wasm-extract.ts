/**
 * Moving a result row out of `sqlite-wasm`, one cell at a time, without oo1.
 *
 * **Why this exists.** oo1's `Stmt.get()` reads every INTEGER through
 * `sqlite3_column_int64`, which crosses the wasm boundary as a BigInt — one
 * allocation per integer cell — and it re-checks that the statement is open,
 * that it has a row and that the index is in range, through `xWrap`'s argument
 * adapters, on every cell. The dictionary's hot statements are wide and long
 * (the gloss candidates are 5,000 rows of nine columns per keystroke; `open()`
 * reads all 14,625 `chars` rows), so that per-cell overhead is most of what the
 * worker spends on a query once SQLite has stepped. `HANDOFF.md` "The
 * dictionary's cell extractor, measured and built" has the measurements.
 *
 * **What it must not change is the value.** Every branch below is written
 * against oo1 3.53.4's own `Stmt.get(ndx)` followed by `narrow()`, which is the
 * path it replaces, and `tests/unit/dict/wasm-extract.test.ts` compares the two
 * over every cell of every table in the real artifact plus the edge values the
 * artifact does not happen to hold:
 *
 *  - **INTEGER** is read with `sqlite3_column_double`. SQLite converts an int64
 *    to a double with a plain C cast, which is exact for every magnitude up to
 *    2^53 and monotonic beyond it — so a value oo1 would have returned as a
 *    safe `number` comes back as the same `number`, and a value outside
 *    `Number.MIN_SAFE_INTEGER…MAX_SAFE_INTEGER` lands outside that range here
 *    too and throws exactly the error `narrow()` throws for oo1's BigInt,
 *    formatted from the exact int64 rather than the rounded double. It never
 *    uses `sqlite3_column_int`, which would truncate to 32 bits in silence:
 *    `entries.hsk_sort` holds `HSK_SORT_SENTINEL`, 2^53 − 1.
 *  - **FLOAT** is `sqlite3_column_double`, as it is in oo1.
 *  - **TEXT** is `sqlite3_column_text` then `sqlite3_column_bytes`, in that
 *    order, decoded by `wasm.typedArrayToString` over exactly that many bytes —
 *    which is what oo1's own `capi.sqlite3_column_text` does, with the same
 *    decoder (UTF-8, replacement rather than throwing, a leading BOM
 *    stripped). It is length-delimited, not NUL-terminated, so an embedded
 *    U+0000 survives in both.
 *  - **BLOB** is `sqlite3_column_bytes` then `sqlite3_column_blob`, copied into
 *    a fresh `Uint8Array` that owns its own buffer — never a view on the wasm
 *    heap, which the next step overwrites and a heap growth detaches.
 *  - **NULL** is `null`.
 *
 * One ordering difference, and it cannot be reached: oo1 read a whole row
 * before `narrow()` saw any of it, so a `get()` error on a later column would
 * have beaten a range error on an earlier one. This throws at the first bad
 * cell. `get()`'s only error of its own is an unknown type code, which
 * `sqlite3_column_type` never returns.
 */
import type { PreparedStatement, Sqlite3Static, SqlValue as WasmSqlValue } from '@sqlite.org/sqlite-wasm';

import type { SqlValue } from '../sql';

/**
 * The library's `SqlValue` is wider than ours — it admits `bigint`, `Int8Array`
 * and `ArrayBuffer`. Narrow at the boundary rather than widening the frozen
 * type: the artifact's largest integer is `HSK_SORT_SENTINEL`, which is
 * `Number.MAX_SAFE_INTEGER` exactly, so a value that will not fit in a double
 * means the file is not this dictionary and throwing is the right answer.
 *
 * The extractor below does not go through this; it is kept as the definition
 * the extractor is tested against, applied to oo1's `get()`.
 */
export function narrow(key: string, value: WasmSqlValue): SqlValue {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new TypeError(`column ${key} does not fit in a JS number: ${value}`);
    }
    return Number(value);
  }
  if (value instanceof Uint8Array) return value;
  if (value instanceof Int8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError(`column ${key} came back as ${typeof value}, which SqlValue does not cover`);
}

/** Reads every row a stepped-and-bound statement has left into `rows`. */
export type RowReader = (
  statement: PreparedStatement,
  columns: readonly string[],
  rows: Record<string, SqlValue>[],
) => void;

/**
 * The raw exports and helpers this file calls. Typed here because the library
 * types `exports` as `any` and leaves `ptr` and `typedArrayToString` out.
 */
interface ColumnExports {
  sqlite3_column_type(stmt: number, index: number): number;
  sqlite3_column_double(stmt: number, index: number): number;
  sqlite3_column_text(stmt: number, index: number): number;
  sqlite3_column_bytes(stmt: number, index: number): number;
  sqlite3_column_blob(stmt: number, index: number): number;
}
interface WasmHelpers {
  ptr?: { size?: number };
  typedArrayToString(heap: Uint8Array, begin: number, end: number): string;
}

/**
 * Builds the reader for one initialised runtime.
 *
 * Throws if the build is not wasm32. Every published `@sqlite.org/sqlite-wasm`
 * build so far is; a memory64 build would pass pointers as BigInt and every raw
 * call below would be wrong, so it is refused once, loudly, when the worker
 * builds its reader, rather than per cell.
 */
export function rowReader(runtime: Sqlite3Static): RowReader {
  const { capi, wasm } = runtime;
  const exports = wasm.exports as ColumnExports;
  const helpers = wasm as unknown as WasmHelpers;
  if (helpers.ptr?.size !== 4) {
    throw new TypeError(`sqlite-wasm pointers are ${String(helpers.ptr?.size)} bytes, not 4`);
  }
  const { SQLITE_INTEGER, SQLITE_FLOAT, SQLITE_TEXT, SQLITE_BLOB, SQLITE_NULL } = capi;
  const { MAX_SAFE_INTEGER, MIN_SAFE_INTEGER } = Number;

  return (statement, columns, rows) => {
    const pointer = statement.pointer as number;
    const width = columns.length;
    while (statement.step()) {
      const row: Record<string, SqlValue> = {};
      for (let index = 0; index < width; index += 1) {
        let value: SqlValue;
        switch (exports.sqlite3_column_type(pointer, index)) {
          case SQLITE_INTEGER: {
            value = exports.sqlite3_column_double(pointer, index);
            if (value > MAX_SAFE_INTEGER || value < MIN_SAFE_INTEGER) {
              // The exact int64 for the message, as `narrow()` would print it.
              const exact = capi.sqlite3_column_int64(pointer, index);
              throw new TypeError(`column ${columns[index]} does not fit in a JS number: ${exact}`);
            }
            break;
          }
          case SQLITE_FLOAT:
            value = exports.sqlite3_column_double(pointer, index);
            break;
          case SQLITE_TEXT: {
            const text = exports.sqlite3_column_text(pointer, index);
            if (!text) {
              value = null;
              break;
            }
            const bytes = exports.sqlite3_column_bytes(pointer, index);
            // oo1's own decode, called directly: the library's default
            // `TextDecoder`, and a copy first if the heap is ever shared. The
            // heap view is taken after both calls: either may allocate (a
            // type conversion does), and a growth replaces the buffer.
            value = helpers.typedArrayToString(wasm.heap8u(), text, text + bytes);
            break;
          }
          case SQLITE_BLOB: {
            const bytes = exports.sqlite3_column_bytes(pointer, index);
            const blob = exports.sqlite3_column_blob(pointer, index);
            value = bytes ? wasm.heap8u().slice(blob, blob + bytes) : new Uint8Array(0);
            break;
          }
          case SQLITE_NULL:
            value = null;
            break;
          default:
            throw new TypeError(`column ${columns[index]} has a type SQLite does not define`);
        }
        row[columns[index]] = value;
      }
      rows.push(row);
    }
  };
}
