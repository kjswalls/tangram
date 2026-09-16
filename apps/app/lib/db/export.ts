/**
 * The local backup's **serializer** (docs/plans/web.md W5).
 *
 * `exportAll()` on the repository produces the `Snapshot` — the rows. This
 * module turns a `Snapshot` into the bytes a learner downloads, and it is
 * deliberately the only place that decides what those bytes look like, because
 * two readers of the same rows have to produce the same file: `backend.md` B5's
 * `exportAccount()` pulls the same stores from PostgREST and hands them here,
 * and its criterion is that the two files are byte-identical.
 *
 * That is why the serializer is **canonical** rather than a bare
 * `JSON.stringify`. Two things are normalised:
 *
 * - **Rows are ordered by `id`.** Dexie's `toArray()` already returns primary-key
 *   order, so the local path is stable by accident; PostgREST's is not, and an
 *   unordered read would make an identical database serialise to two different
 *   files.
 * - **Object keys are sorted, recursively.** Structured clone preserves
 *   insertion order, so a row that came back from IndexedDB carries whatever
 *   order it was written in — which differs between a row written by `grade()`
 *   and the same row restored from a file. Sorting makes "the same database
 *   serialises to the same bytes" true, which is what lets the round-trip test
 *   compare bytes rather than shapes.
 *
 * No DOM here and no side effects: this module is imported under Node by the
 * unit suite, and `lib/db` must stay importable there (PLAN.md §3.3).
 */

import type { Snapshot } from '@/lib/db/repository';
import { STORES } from '@/lib/db/schema';

/**
 * The envelope's format version — `Snapshot['format']`, as one constant rather
 * than a literal repeated at every writer. Bump it when the *envelope* changes,
 * which is a different question from `dbVersion`: that one records the schema
 * the rows were cut at.
 */
export const SNAPSHOT_FORMAT = 1;

/** Every store a snapshot carries — the eight synced ones plus `ask_cache`. */
export type SnapshotStore = keyof Snapshot['rows'];

/**
 * Derived from the schema, never hand-listed: a store added to `STORES` is then
 * a store this module already knows about, and the type above fails to compile
 * until `SyncedRow` has decided whether it syncs (docs/plans/wave-zero.md §5).
 */
export const SNAPSHOT_STORES = Object.keys(STORES) as readonly SnapshotStore[];

/** Any row a snapshot holds. Every one of them keys on a string `id` (§3.3). */
type AnyRow = Snapshot['rows'][SnapshotStore][number];

function byId(a: AnyRow, b: AnyRow): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Sort every plain object's keys, all the way down. Arrays keep their order —
 * `glosses` and `tokens` are sequences and reordering them would change what
 * the card says.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  // `Object.create(null)`, not `{}`: `JSON.parse` gives `{"__proto__": …}` an
  // OWN property of that name, and copying it onto an ordinary object literal
  // assigns the prototype instead of a key — so a hand-edited backup could
  // change the shape of the object being serialised. A null-prototype object
  // has no `__proto__` setter to trip over, and `JSON.stringify` treats it like
  // any other object.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source).sort()) {
    // `JSON.stringify` drops an undefined property; do the same here so a row
    // with `note: undefined` and a row with no `note` serialise identically.
    if (source[key] === undefined) continue;
    out[key] = canonical(source[key]);
  }
  return out;
}

/** The snapshot as it will be written: stores in schema order, rows by id. */
function canonicalSnapshot(snapshot: Snapshot): Record<string, unknown> {
  const rows: Record<string, unknown> = {};
  for (const store of SNAPSHOT_STORES) {
    rows[store] = [...snapshot.rows[store]].sort(byId).map(canonical);
  }
  return {
    format: snapshot.format,
    dbVersion: snapshot.dbVersion,
    createdAt: snapshot.createdAt,
    rows,
  };
}

/**
 * The backup file's bytes. Pretty-printed on purpose: a backup a learner can
 * open, read and see their own words in is a backup they trust, and the
 * difference is a few hundred kilobytes on a file that is downloaded by hand.
 */
export function serializeSnapshot(snapshot: Snapshot): string {
  return `${JSON.stringify(canonicalSnapshot(snapshot), null, 2)}\n`;
}

/** How many rows each store holds — what the UI counts before it overwrites. */
export function snapshotCounts(snapshot: Snapshot): Record<SnapshotStore, number> {
  const counts = {} as Record<SnapshotStore, number>;
  for (const store of SNAPSHOT_STORES) counts[store] = snapshot.rows[store].length;
  return counts;
}

/**
 * The two numbers the restore confirmation says out loud.
 *
 * **Live rows only, unlike everything else here.** `snapshot.rows.cards`
 * carries tombstones by contract, and it must — a round trip that drops them
 * resurrects deleted cards on the next sync. But this number sits directly
 * above "it cannot be undone" in the confirmation, and it is the number the
 * learner weighs that against; counting cards they deleted months ago against
 * the card count the rest of the app shows them (`cardCountsByState`, which
 * filters tombstones) is two different rules on one screen, with the
 * irreversible button between them.
 *
 * `reviews` has no tombstone — it is append-only — so it is just the length.
 */
export function snapshotSummary(snapshot: Snapshot): { cards: number; reviews: number } {
  return {
    cards: snapshot.rows.cards.filter((card) => card.deletedAt === null).length,
    reviews: snapshot.rows.reviews.length,
  };
}

/**
 * `tangram-backup-2026-09-16.json`.
 *
 * Dated in the learner's **local** time, because the date they will look for is
 * the day they pressed the button, not the UTC day it happened to be.
 */
export function snapshotFilename(snapshot: Snapshot): string {
  const at = new Date(snapshot.createdAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `tangram-backup-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.json`;
}
