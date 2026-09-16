/**
 * The build (docs/plans/web.md W1, docs/STACK.md §2.2).
 *
 * Plain SPA: `pnpm build` emits a directory of static files with no framework
 * runtime, which is the whole point — Capacitor and Tauri both need exactly that
 * and Next's `output: 'export'` removes the four Next features this repo used.
 */
import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { apiRoutes } from './vite-plugins/api.ts';
import { dictAssets } from './vite-plugins/dict-assets.ts';
import { staticHeaders } from './vite-plugins/headers.ts';

const root = import.meta.dirname;
// The workspace root, named once. `data/` lives there, not in this project
// (docs/plans/wave-zero.md §1), and `src/routes/settings.tsx` imports the
// committed ATTRIBUTION.md out of it at build time.
const workspaceRoot = resolve(root, '..', '..');

export default defineConfig({
  /**
   * `base` is '/' and that is not a placeholder.
   *
   * Capacitor and Tauri serve `dist/` from the ROOT of a custom scheme
   * (`capacitor://localhost/`, `tauri://localhost/`) or of `http://localhost`,
   * which a root-absolute base satisfies exactly. A relative base ('./') would
   * actively break this build: Vite would emit `./assets/<hash>.js` into
   * index.html, and under the SPA fallback a hard refresh of `/lists/<id>`
   * returns that same document, whose script URL then resolves to
   * `/lists/assets/<hash>.js`, which the fallback answers with index.html again
   * — a deep route that boots to a blank page. Relative base and history routing
   * are mutually exclusive; this build picks history routing.
   *
   * A subpath deploy is a separate build invocation (`vite build --base=/sub/`)
   * whose output is served only under that prefix.
   */
  base: '/',
  root,
  plugins: [
    react(),
    // Tailwind 4 through its own Vite plugin rather than through
    // postcss.config.mjs. STACK §7 named this as unchecked; see HANDOFF.md for
    // which path was taken and why.
    tailwindcss(),
    apiRoutes(),
    // The two header rules next.config.ts's headers() block carried, per path.
    staticHeaders(),
    // The dictionary artifacts, out of the workspace-root `data/`, until
    // `web.md` W2's copy step puts them in `public/` (docs/plans/data.md D4).
    dictAssets(),
  ],
  optimizeDeps: {
    /**
     * `@sqlite.org/sqlite-wasm` is excluded on the package's own instruction.
     * Pre-bundling rewrites the module, and the wasm binary is located with
     * `new URL('sqlite3.wasm', import.meta.url)` — relative to wherever the
     * module ended up. Left alone, dev serves it from `node_modules` and the
     * URL resolves; pre-bundled, it resolves into `.vite/deps` where the binary
     * is not.
     */
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  resolve: {
    alias: {
      '@': resolve(root),
      // Never `@/../../data`: an alias that has to be un-counted at each call
      // site is the path arithmetic W0 spent a phase removing.
      '@data': resolve(workspaceRoot, 'data'),
    },
  },
  server: {
    // `@data` is outside the Vite root, so dev and preview have to be told it is
    // allowed to be read. `build` does not care.
    fs: { allow: [root, workspaceRoot] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    /**
     * `.vite/manifest.json` — on, and three things read it (docs/plans/web.md
     * W2 and W3). `scripts/smoke.ts` walks it to assert every hashed asset is
     * 200, which is the only falsifiable check left once the SPA fallback
     * answers every page path with `index.html`; W3 hashes it into the service
     * worker's cache name; and `sw.template.js`'s precache list is the entry
     * chunk and stylesheet read out of it rather than a hand-kept list.
     */
    manifest: true,
    // Off, as Next's was: `productionBrowserSourceMaps` defaults to false and
    // the deleted next.config.ts did not set it. `dist/` is uploaded verbatim to
    // the static host (W2), so `true` would publish 2.8 MB of full application
    // source alongside a 654 KB bundle. A phase whose job is to change the build
    // system should not also change what the build publishes.
    sourcemap: false,
  },
});
