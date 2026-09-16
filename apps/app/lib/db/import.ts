/**
 * The local backup's **reader** (docs/plans/web.md W5).
 *
 * `lib/db/export.ts` writes the file; this module is what stands between a file
 * on a learner's disk and `importAll()`, which is destructive by contract. Every
 * refusal here is a database that was not replaced.
 *
 * **This is not `tests/unit/db/import.test.ts`.** That file is the *import
 * surface* guard — PLAN.md §3.3's rule that importing anything under `lib/db`
 * under Node must not throw and must not open a database — and it predates this
 * module. The round trip is `tests/unit/db/backup.test.ts`.
 *
 * What it refuses, and why each one is a real file somebody will hand it:
 *
 * - **Not JSON at all.** A truncated download, or the wrong file entirely.
 * - **A newer envelope `format`.** Written by a Tangram that knows something
 *   this one does not. Refusing is the only safe answer; guessing would restore
 *   a partial database and call it a success.
 * - **A newer `dbVersion`.** Same reasoning one layer down: the rows were cut
 *   against a schema this build has never seen.
 * - **A missing store.** A hand-edited or partially-written file. Accepting it
 *   would silently empty that store, which is the exact failure the wave-0 guard
 *   in `tests/unit/db/repository.test.ts` was written about — a backup that
 *   restores nothing and reports success.
 * - **A row without a string `id`.** Every row keys on one (§3.3), and Dexie
 *   would reject it mid-`bulkPut` anyway; catching it first means the refusal
 *   names the file rather than the database.
 * - **Two rows with the same `id` in one store.** `bulkPut` collapses them
 *   last-wins and reports success, so a hand-merged file loses rows silently.
 * - **A row whose *indexed* value is not a number where the queries need one.**
 *   This is the sharpest one and it is worth stating plainly: **IndexedDB
 *   silently omits a row from an index when its key path holds a value that is
 *   not a valid key.** A restored card whose `due` is a string, `null` or
 *   absent is returned by `allCards()` and counted by `cardCountsByState()`,
 *   and is **never** returned by the due queue — so the restore reports
 *   success, the card count looks right, and the learner's Practice queue is
 *   empty forever. No error is raised anywhere. The same holds for
 *   `reviews.reviewedAt`, which every statistic reads through.
 *
 *   The check is deliberately **narrow**: only the two columns whose absence
 *   from an index breaks a query silently. It is *not* "every indexed field
 *   must be a valid key", because several indexed fields are nullable on
 *   purpose — `cards.entryId` and `cards.wordId` are `null` on a phrase card,
 *   and `lib/db/schema.ts` says in as many words that such a row being absent
 *   from those indexes "is IndexedDB's rule about null keys and not a decision
 *   made here".
 * - **A row nested deeper than any row shape goes.** Nothing legitimate is,
 *   and the serializer walks rows recursively — so a hostile file is otherwise
 *   a way to make every *later* export throw `RangeError`, which is a
 *   permanently broken backup button with no way out through the UI.
 *
 * `backend.md` B5 is the reason several of these are not theoretical: its
 * `exportAccount()` pulls the same stores from PostgREST and feeds them through
 * this same door, and PostgREST hands back numerics as strings by default.
 *
 * An **older** `dbVersion` is accepted and upgraded, because there is exactly
 * one shape difference across the three versions that have existed and it is
 * the one `TangramDb`'s own v3 upgrade already handles.
 */

import type { Snapshot } from '@/lib/db/repository';
import { SNAPSHOT_FORMAT, SNAPSHOT_STORES, type SnapshotStore } from '@/lib/db/export';
import {
  DB_VERSION,
  DEFAULT_CARD_DIRECTION,
  systemListKey,
  type CardRow,
  type ListRow,
} from '@/lib/db/schema';

/** Why a file was refused. The UI maps these to copy; tests assert on them. */
export type SnapshotProblem =
  | 'not-json'
  | 'not-a-snapshot'
  | 'future-format'
  | 'future-schema'
  | 'missing-store'
  | 'bad-row';

/**
 * A refusal a learner can act on. `message` is written to be shown as-is: the
 * alternative is a `SyntaxError` from `JSON.parse` on screen, which tells them
 * nothing about which file to try instead.
 */
export class SnapshotError extends Error {
  readonly problem: SnapshotProblem;

  constructor(problem: SnapshotProblem, message: string) {
    super(message);
    this.name = 'SnapshotError';
    this.problem = problem;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Per store, the columns that must hold a finite number — see the header.
 *
 * Both are *indexed* columns that a query reads through, and both are declared
 * non-nullable by `lib/db/schema.ts`. Nothing else is listed, deliberately: an
 * over-strict shape check here would refuse a backup the app could restore
 * perfectly well, which for a recovery tool is its own kind of failure.
 */
const REQUIRED_NUMBERS: Partial<Record<SnapshotStore, readonly string[]>> = {
  // Mirrors `fsrs.due`; the column `listDue` and `listLearningSoon` range over.
  cards: ['due'],
  // What `reviewsBetween`, the dashboard and the optimizer all filter on.
  reviews: ['reviewedAt'],
};

/** How deep a legitimate row goes, with room to spare. See the header. */
const MAX_ROW_DEPTH = 16;

function tooDeep(value: unknown, depth: number): boolean {
  if (depth > MAX_ROW_DEPTH) return true;
  if (Array.isArray(value)) return value.some((item) => tooDeep(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.values(value).some((item) => tooDeep(item, depth + 1));
}

/**
 * Validate a parsed value as a `Snapshot`, or throw `SnapshotError`.
 *
 * Called by `parseSnapshot` **and** by `importAll` itself, so that a caller who
 * builds a snapshot in memory gets the same refusals as a caller who read one
 * off disk. The type system says `importAll` takes a `Snapshot`; a file does
 * not, and the gap between those two is where a hand-edited backup lives.
 */
export function validateSnapshot(value: unknown): Snapshot {
  if (!isRecord(value)) {
    throw new SnapshotError('not-a-snapshot', 'That file is not a Tangram backup.');
  }

  if (typeof value.format !== 'number' || !Number.isInteger(value.format) || value.format < 1) {
    throw new SnapshotError('not-a-snapshot', 'That file is not a Tangram backup.');
  }
  if (value.format > SNAPSHOT_FORMAT) {
    throw new SnapshotError(
      'future-format',
      'That backup was made by a newer version of Tangram. Update the app, then try again.',
    );
  }

  if (typeof value.dbVersion !== 'number' || !Number.isInteger(value.dbVersion) || value.dbVersion < 1) {
    throw new SnapshotError('not-a-snapshot', 'That file is not a Tangram backup.');
  }
  if (value.dbVersion > DB_VERSION) {
    throw new SnapshotError(
      'future-schema',
      'That backup was made by a newer version of Tangram. Update the app, then try again.',
    );
  }

  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) {
    throw new SnapshotError('not-a-snapshot', 'That file is not a Tangram backup.');
  }

  if (!isRecord(value.rows)) {
    throw new SnapshotError('not-a-snapshot', 'That file is not a Tangram backup.');
  }

  const rows = value.rows;
  for (const store of SNAPSHOT_STORES) {
    const list = rows[store];
    if (!Array.isArray(list)) {
      throw new SnapshotError(
        'missing-store',
        `That backup is incomplete — it has no “${store}”. Restoring it would delete those rows.`,
      );
    }
    const seen = new Set<string>();
    const required = REQUIRED_NUMBERS[store] ?? [];
    for (const row of list) {
      if (!isRecord(row) || typeof row.id !== 'string' || row.id === '') {
        throw new SnapshotError('bad-row', `That backup has a damaged row in “${store}”.`);
      }
      if (seen.has(row.id)) {
        throw new SnapshotError(
          'bad-row',
          `That backup has two rows with the same id in “${store}”. Restoring it would lose one.`,
        );
      }
      seen.add(row.id);
      for (const field of required) {
        const held = row[field];
        if (typeof held !== 'number' || !Number.isFinite(held)) {
          throw new SnapshotError(
            'bad-row',
            `That backup has a damaged “${field}” in “${store}”. Restoring it would hide those rows from the app.`,
          );
        }
      }
      if (tooDeep(row, 0)) {
        throw new SnapshotError('bad-row', `That backup has a damaged row in “${store}”.`);
      }
    }
  }

  // A store the schema does not have means the file came from something else,
  // or from a build whose schema moved without bumping `dbVersion`. Either way
  // it is not this database's backup, and silently dropping the extra rows
  // would be the quiet half of a restore that loses data.
  const known = new Set<string>(SNAPSHOT_STORES);
  for (const store of Object.keys(rows)) {
    if (!known.has(store)) {
      throw new SnapshotError('not-a-snapshot', `That backup holds an unknown table (“${store}”).`);
    }
  }

  return value as unknown as Snapshot;
}

/** Read a downloaded backup. The one entry point for bytes off disk. */
export function parseSnapshot(text: string): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SnapshotError('not-json', 'That file is not readable — it may be incomplete.');
  }
  return validateSnapshot(parsed);
}

/**
 * Bring an older snapshot up to the current schema.
 *
 * **Both of the bumps below the current one changed a row, not just an index,
 * and an earlier version of this comment said otherwise.** It claimed v2 was a
 * pure index declaration; it is not. Read `TangramDb`'s own upgrades: v2
 * declares `&systemKey` on `lists` **and stamps the key onto the system lists
 * the old database already has**, because `systemKey` is a column
 * (`lib/db/schema.ts`), not an index over one that was already there. Found by
 * W5's adversarial review.
 *
 * Both failures are the same failure, one store apart: **a row that exists and
 * can never be found by the query that looks for it.**
 *
 * - **v1 → v2, `lists.systemKey`.** IndexedDB does not index a row whose key
 *   path is missing, so a restored system list with no `systemKey` is invisible
 *   to the unique index — and `ensureSystemLists` then makes all eight again,
 *   leaving the restored members hanging off orphans. The stamp mirrors the v2
 *   upgrade exactly, tombstone rule included: a tombstone never holds the key
 *   (deleting a system list is a reset, and the list has to be creatable
 *   again), and where a v1 database already carried two copies of one key, the
 *   **oldest wins** and the later one is retired — because the oldest is the one
 *   the app has been using, and the alternative is a restore that fails the
 *   unique index.
 * - **v2 → v3, `cards.direction`.** Same mechanism over `[entryId+direction]`:
 *   a card that exists, is due, and can never be found by `cardForEntry`.
 *
 * `dbVersion` is left as it was cut: it is provenance, not a mutable field.
 * Nothing downstream reads it after this point.
 *
 * Today only a hand-forged file can be below 3 — `exportAll` has always stamped
 * `DB_VERSION` and no earlier exporter ever existed — so this is a defensive
 * branch. It is written out anyway because `backend.md` B5 reads this door, and
 * because a defensive branch documented as complete when it is not is worse
 * than no branch at all.
 */
export function upgradeSnapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.dbVersion >= DB_VERSION) return snapshot;

  const cards = snapshot.rows.cards.map((card: CardRow) =>
    card.direction ? card : { ...card, direction: DEFAULT_CARD_DIRECTION },
  );

  const lists = snapshot.dbVersion >= 2 ? snapshot.rows.lists : stampSystemKeys(snapshot.rows.lists);

  return { ...snapshot, rows: { ...snapshot.rows, cards, lists } };
}

/** The v1 → v2 half of `upgradeSnapshot`; see its comment. */
function stampSystemKeys(rows: readonly ListRow[]): ListRow[] {
  const oldestFirst = [...rows].sort((a, b) => a.createdAt - b.createdAt);
  const claimed = new Set<string>();
  const stamped = new Map<string, ListRow>();

  for (const row of oldestFirst) {
    const key = systemListKey(row.kind, row.band);
    if (key === undefined || row.deletedAt !== null) {
      stamped.set(row.id, row);
      continue;
    }
    if (claimed.has(key)) {
      const now = Date.now();
      stamped.set(row.id, { ...row, deletedAt: now, updatedAt: now });
      continue;
    }
    claimed.add(key);
    stamped.set(row.id, row.systemKey === key ? row : { ...row, systemKey: key });
  }

  // Back in the order the snapshot had them: the serializer sorts by id anyway,
  // but a function that quietly reorders its input is a function whose output
  // cannot be compared against anything.
  return rows.map((row) => stamped.get(row.id) ?? row);
}

/** Re-exported so a caller needs one import to read a file. */
export type { SnapshotStore };
