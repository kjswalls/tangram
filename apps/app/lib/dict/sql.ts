/**
 * The platform seam under `DictStore` (docs/plans/data.md D1, D2).
 *
 * Everything interesting about the dictionary — routing, ranking, grouping,
 * paging, the segmentation DP — lives above this interface and is written once
 * for all three platforms. This is the dumb pipe underneath it, and it is the
 * only thing that differs between Node, `sqlite-wasm` in a worker and the
 * Capacitor plugin on a phone.
 *
 * **Frozen by D1's first commit.** `core.md` and `ios.md` gate on this file
 * existing rather than on the whole of D1, so a change here is not a refactor:
 * it stops the build and goes into `HANDOFF.md` (CLAUDE.md, "Shared surfaces").
 */

/** What a parameter may be and what a column comes back as. `BLOB` is `Uint8Array`. */
export type SqlValue = string | number | null | Uint8Array;

export interface SqlQuery {
  sql: string;
  params?: readonly SqlValue[];
}

export interface SqlRunner {
  /**
   * One round trip. Every query in the batch runs on the same read-only
   * connection, in order, and the results come back in the same order.
   *
   * The batch is the unit on purpose: on the Capacitor bridge every call is a
   * JSON round trip (~1–5 ms plus serialisation), so a `DictStore` method is at
   * most two of these and `tests/unit/dict/` counts them (data.md D2).
   */
  query(batch: readonly SqlQuery[], signal?: AbortSignal): Promise<Record<string, SqlValue>[][]>;
  close(): Promise<void>;
}
