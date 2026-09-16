import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    /**
     * `@/*` → `apps/app/*`, the same mapping `tsconfig.json` declares and
     * `scripts/build.ts` implements for the bundle.
     *
     * `backend.md` B2 removed every `@/lib/**` import from `src/**` — the
     * dictionary is gone from this server — but the alias stays, because
     * `packages/ai/cache-key.ts` still imports `sha1Hex` from `@/lib/dev/sha1`
     * at run time and this suite imports `src/app.ts`, which reaches it through
     * `@tangram/ai`. It is `packages/ai`'s edge now, not this package's.
     */
    alias: { '@': resolve(here, '..', 'app') },
  },
  test: {
    // Node, not jsdom: nothing in this package renders anything.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
