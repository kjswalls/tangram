/**
 * The db barrel. Import `@/lib/db` for the seam; never reach past it into Dexie.
 */

export * from '@/lib/db/schema';
export * from '@/lib/db/repository';
export { createDexieRepository, newId, TangramDb, toEntrySnapshot } from '@/lib/db/dexie';
export { closeDb, getDb, getRepository } from '@/lib/db/get-db';
// The local backup (docs/plans/web.md W5). Named rather than `export *`, so the
// barrel says what the seam offers instead of re-exporting every helper the two
// modules happen to have.
export {
  serializeSnapshot,
  snapshotCounts,
  snapshotFilename,
  snapshotSummary,
  SNAPSHOT_FORMAT,
  SNAPSHOT_STORES,
  type SnapshotStore,
} from '@/lib/db/export';
export {
  parseSnapshot,
  SnapshotError,
  upgradeSnapshot,
  validateSnapshot,
  type SnapshotProblem,
} from '@/lib/db/import';
