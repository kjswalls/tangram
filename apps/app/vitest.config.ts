import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(root),
      /**
       * `@server/*` → `apps/server/src/*`, for the unit suite only.
       *
       * `backend.md` B1 moves `/api/ask`, `/api/examples` and `/api/recall` to
       * `apps/server` and says their tests "stay in `apps/app`'s suite for B1 —
       * pointed at the moved handlers through the workspace". They have to: all
       * four call `requireDictData` and run against the real 124k-entry
       * dictionary in `data/`, and a server package that (after B2) ships no
       * `data/` cannot host them.
       *
       * It is deliberately absent from `vite.config.ts`. Nothing in the app's
       * production bundle may import a server module, and an alias that existed
       * only here is the cheapest way to say so.
       */
      '@server/': `${resolve(root, '..', 'server', 'src')}/`,
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['tests/unit/setup.ts'],
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
  },
});
