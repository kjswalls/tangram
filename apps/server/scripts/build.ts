/**
 * `pnpm -F server build` — bundle `src/` into `dist/`, then stamp it.
 *
 * **Why a bundler, when B0 emitted with `tsc`.** B0's server imported nothing
 * but Hono, so `tsc` could emit `dist/*.js` that plain `node` loaded. From
 * `backend.md` B1 the three model routes live here, and B1 says the dictionary
 * comes with them — "on purpose and temporarily", until B2's contract flip. So
 * this package's module graph now reaches three places `tsc`'s emit cannot make
 * loadable:
 *
 *  1. **`packages/ai/**` and `packages/access/**` export TypeScript source.**
 *     Both package.jsons record the debt: against a deploy artifact where
 *     `@tangram/ai` is a real directory under `node_modules` rather than a pnpm
 *     symlink, Node's type stripping is refused and the emitted `dist/index.js`
 *     fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. HANDOFF.md says
 *     "whoever needs the server to load this package must add a build emitting
 *     `dist/*.js`". Bundling is that, and it settles it for both packages at
 *     once without either having to grow a build of its own.
 *  2. **`apps/app/lib/dict/**` and `lib/server/dict.ts` use extensionless
 *     relative imports** (`from '../artifact'`). Node's ESM resolver requires an
 *     extension and `tsc` does not add one, so no emit of that graph is
 *     loadable. A bundler resolves them the way Vite and vitest already do.
 *  3. **`@/*`**, which is a tsconfig path mapping and not a runtime concept.
 *
 * The bundle is also the better deploy artifact, and that is not incidental:
 * `dist/index.js` plus the four real `dependencies` is the whole of it, so a
 * host that runs `pnpm install --prod` on this package alone gets a server that
 * starts, with no workspace symlinks and no type stripping anywhere.
 *
 * **What stays external, and why those four.** `dependencies` — Hono, its Node
 * adapter, the Anthropic SDK and zod. They are real, published, versioned
 * packages; bundling them would bury the versions a deploy is running and put
 * the SDK's own conditional requires through a static analyser for no gain.
 * Node built-ins are external by virtue of `platform: 'node'`. Everything else
 * — every workspace package and every app module — is first-party source and is
 * inlined, which is the point.
 *
 * `tsc` still runs, as `pnpm -F server typecheck`. esbuild strips types without
 * checking them, so the build is deliberately NOT the type gate; the root
 * `build` script runs `typecheck` first for exactly that reason.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, type Plugin } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, '..');
const appDir = resolve(packageDir, '..', 'app');

const manifest = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};

/**
 * `@/*` → `apps/app/*`, resolved the way the tsconfig path mapping means it.
 *
 * A plugin rather than esbuild's `alias`, because `alias` matches package names
 * and `@` is not one — it is a bare prefix this repo has used since Phase 0. The
 * second `resolve` call is what applies esbuild's ordinary extension search, so
 * `@/lib/types` finds `lib/types.ts` exactly as Vite and vitest do.
 */
const appAlias: Plugin = {
  name: 'tangram:app-alias',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, async (args) => {
      const resolved = await builder.resolve(`./${args.path.slice(2)}`, {
        kind: 'import-statement',
        resolveDir: appDir,
      });
      if (resolved.errors.length > 0) return { errors: resolved.errors };
      return { path: resolved.path, external: resolved.external };
    });
  },
};

const result = await build({
  absWorkingDir: packageDir,
  // `smoke.ts` is bundled too, so the after-deploy check can be run on a box
  // that has `dist/` and no `tsx`. `pnpm -F server smoke` still runs the source.
  entryPoints: ['src/index.ts', 'src/smoke.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Off for the same reason `apps/app`'s build has them off: `dist/` is what
  // gets uploaded, and a source map publishes the whole first-party tree.
  sourcemap: false,
  minify: false,
  // Keeps the dynamic `import('../dict/runners/node')` inside the one file
  // rather than emitting a chunk beside it; `dist/` stays two files plus the
  // stamp, which is what makes "is this the build I deployed" answerable.
  splitting: false,
  external: Object.keys(manifest.dependencies ?? {}),
  plugins: [appAlias],
  logLevel: 'info',
  metafile: false,
});

if (result.errors.length > 0) process.exitCode = 1;
