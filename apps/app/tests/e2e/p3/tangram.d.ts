import type { Repository, TangramDb } from '@/lib/db';
import type { DecompStore } from '@/lib/dict/decomp-store';
import type { DictStore } from '@/lib/dict/store';

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
      /** The app's own `DictStore` (docs/plans/data.md D6). A getter — reading it builds one. */
      dict: DictStore;
      decomp: DecompStore;
      getRepository: () => Repository;
      getDb: () => TangramDb;
      closeDb: () => Promise<void>;
    };
  }
}

export {};
