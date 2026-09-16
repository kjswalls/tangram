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
     * It is here because `backend.md` B1's three model routes read
     * `lib/server/dict.ts` and `packages/ai/**` reads `@/lib/types` — "the
     * dictionary comes with them, on purpose and temporarily". Without it the
     * suite cannot so much as import `src/app.ts`. B2 removes it along with the
     * mapping in the tsconfig.
     */
    alias: { '@': resolve(here, '..', 'app') },
  },
  test: {
    // Node, not jsdom: nothing in this package renders anything.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
