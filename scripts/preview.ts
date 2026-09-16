/**
 * Serves the production build.
 *
 * **It existed for a constraint that `backend.md` B1 removed, and it is worth
 * saying what is left.** The Vite preview server has no transform pipeline — it
 * serves `dist/` statically — so the API adapter `web.md` W1 built could not
 * `await import('<app>/app/api/ask/route.ts')` from plain Node. W1 offered two
 * mechanisms and took (a): start preview from a script run under `tsx`, whose
 * loader hook compiles the handler modules on import. B1 deleted that adapter
 * and moved the three handlers to `apps/server`, so nothing here imports a
 * `.ts` module any more.
 *
 * What still justifies a script rather than `vite preview`: it pins the port to
 * **3000**, which is what `scripts/smoke.ts` and `playwright.config.ts` both
 * default to and what `next start` used before them, and it takes
 * `TANGRAM_PREVIEW_OUT_DIR` so a caller can serve a second build without a
 * second config. `tests/e2e/d/access-gate.spec.ts` is that caller: it builds
 * the app a second time against a *gated* API origin, because `VITE_API_BASE`
 * is substituted at build time and the suite's main build points at the ungated
 * one.
 *
 * `PORT` rather than a flag, because that is what `playwright.config.ts` and
 * `pnpm smoke` already pass around.
 */
import { resolve } from 'node:path';

import { preview } from 'vite';

import { dirOf, workspaceRoot } from '../apps/app/lib/server/roots';

const appDir = resolve(workspaceRoot(dirOf(import.meta.url)), 'apps/app');
// 3000, not Vite's 4173: `scripts/smoke.ts` and `playwright.config.ts` both
// default to 3000, and so did the `next start` this replaced. A preview server
// on a different default port than the thing that probes it is a trap that only
// shows up when someone runs the two commands separately, as CLAUDE.md invites.
const port = Number(process.env.PORT ?? 3000);

// Which build to serve. `dist` unless a caller says otherwise; Vite's preview
// server reads `build.outDir`, so this is the one knob that moves it.
const outDir = process.env.TANGRAM_PREVIEW_OUT_DIR?.trim() || 'dist';

const server = await preview({
  root: appDir,
  configFile: resolve(appDir, 'vite.config.ts'),
  build: { outDir },
  preview: { port, strictPort: true, host: '127.0.0.1' },
});

server.printUrls();
