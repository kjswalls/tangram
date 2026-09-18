/**
 * `SqlRunner` over Node's built-in SQLite (docs/plans/data.md D2).
 *
 * The test runner and the only one that needs no new dependency: `node:sqlite`
 * ships with Node 22.22 and wraps SQLite 3.51.2 with FTS5 compiled in. It is
 * what makes D2's and D3's differential tests possible in the first place —
 * the store and the JSON index answer the same query list in the same process,
 * so the comparison is exact rather than a golden file.
 *
 * **Node-only.** Nothing in the app imports it; `lib/dict/runners/wasm.ts` (D4)
 * and `lib/dict/runners/capacitor.ts` (D5a) are the shipping runners, and every
 * assertion written against this one is re-run against those unchanged.
 *
 * A test that imports this file must carry `// @vitest-environment node`: Vite
 * refuses to bundle a Node built-in for the jsdom default.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import type { SqlQuery, SqlRunner, SqlValue } from '../sql';

/**
 * `node:sqlite` returns rows as null-prototype objects and BLOBs as
 * `Uint8Array`, which is what `SqlValue` promises. `bigint` can come back from
 * an INTEGER wider than 2^53; the artifact has none — the largest value in it is
 * `HSK_SORT_SENTINEL`, which is `Number.MAX_SAFE_INTEGER` exactly — so a bigint
 * here means the file is not this artifact and throwing is the right answer.
 */
function toRow(raw: Record<string, unknown>): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value === 'string' || typeof value === 'number') {
      out[key] = value;
    } else if (value instanceof Uint8Array) {
      out[key] = value;
    } else {
      throw new TypeError(`column ${key} came back as ${typeof value}, which SqlValue does not cover`);
    }
  }
  return out;
}

export function nodeRunner(path: string): SqlRunner {
  const db = new DatabaseSync(path, { readOnly: true });
  // Prepared statements are cached by SQL text. Every query in the layer is a
  // constant string with bound parameters except the `IN (…)` ones, whose text
  // varies with the list length — so the cache is bounded by the distinct list
  // lengths a session sees, which is small and self-limiting.
  const prepared = new Map<string, StatementSync>();
  let closed = false;

  function statementFor(sql: string): StatementSync {
    let statement = prepared.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      prepared.set(sql, statement);
    }
    return statement;
  }

  return {
    async query(batch, signal) {
      if (closed) throw new Error('the dictionary connection is closed');
      signal?.throwIfAborted();
      const out: Record<string, SqlValue>[][] = [];
      for (const query of batch as readonly SqlQuery[]) {
        // Checked between statements rather than only once: a batch is the unit
        // of a round trip, and a superseded keystroke should stop paying for the
        // rest of it.
        signal?.throwIfAborted();
        const rows = statementFor(query.sql).all(...((query.params ?? []) as SqlValue[]));
        out.push((rows as Record<string, unknown>[]).map(toRow));
      }
      return out;
    },
    async close() {
      if (closed) return;
      closed = true;
      prepared.clear();
      db.close();
    },
  };
}
