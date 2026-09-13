/**
 * Serves the production build, with the API adapter mounted.
 *
 * **This exists because of one constraint and it is worth stating plainly.** The
 * Vite preview server has no transform pipeline — it serves `dist/` statically —
 * so the adapter's `await import('<app>/app/api/ask/route.ts')` from Node is a
 * bare resolution error. `web.md` W1 offers two mechanisms; this is **(a)**:
 * start preview from a script run under `tsx`, whose loader hook compiles the
 * handler modules on import. `tsx` is already a direct devDependency and is
 * already how `pnpm data`, `pnpm sw` and `pnpm smoke` execute TypeScript under
 * Node, so it adds no dependency and no second build step. Mechanism (b) — a
 * second esbuild/Rollup pass emitting the handlers as a Node-loadable bundle —
 * would have added a build artifact whose only consumer is a bridge that
 * `data.md` D6 and `backend.md` delete. Recorded in HANDOFF.md.
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

const server = await preview({
  root: appDir,
  configFile: resolve(appDir, 'vite.config.ts'),
  preview: { port, strictPort: true, host: '127.0.0.1' },
});

server.printUrls();
