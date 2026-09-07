import type { Repository, TangramDb } from '@/lib/db';

declare global {
  interface Window {
    /**
     * Set by `components/shell/test-hooks.tsx` once the db is first touched.
     * Declared here so the e2e specs can seed and inspect state without casts;
     * the shape must stay exactly what that component assigns.
     */
    __tangram: {
      repo: Repository;
      db: TangramDb;
      getRepository: () => Repository;
      getDb: () => TangramDb;
      closeDb: () => Promise<void>;
    };
  }
}

export {};
