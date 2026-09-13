/**
 * The db barrel. Import `@/lib/db` for the seam; never reach past it into Dexie.
 */

export * from '@/lib/db/schema';
export * from '@/lib/db/repository';
export { createDexieRepository, newId, TangramDb, toEntrySnapshot } from '@/lib/db/dexie';
export { closeDb, getDb, getRepository } from '@/lib/db/get-db';
