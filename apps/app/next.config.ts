import { resolve } from 'node:path';

import type { NextConfig } from 'next';

// The workspace root. `data/` lives there and not in this project directory
// (docs/plans/wave-zero.md §1), so it is ABOVE the Next project — which changes
// two things at once and both have to be set or neither works:
//
//  - `outputFileTracingRoot` has to name it, or Next will not copy a file from
//    outside the project directory into a function bundle at all;
//  - the include globs below are resolved with cwd set to the PROJECT
//    directory, so they have to climb out of it explicitly.
//
// Before the workspace move these were the same directory and `./data/**` was
// right. After it, `./data/**` matched nothing and every dictionary route would
// have 503'd in the deployment while `next dev`, `pnpm start`, `pnpm smoke` and
// the whole e2e suite stayed green — the file is simply on disk for all of them.
// `tests/unit/server/routes.test.ts` now resolves these globs against the
// filesystem rather than only checking that a key exists.
const workspaceRoot = resolve(import.meta.dirname, '..', '..');

const nextConfig: NextConfig = {
  outputFileTracingRoot: workspaceRoot,
  // The dictionary loader reads data/*.json from disk at request time, so the
  // JSON must be traced into the serverless bundle for the routes that use it.
  // Tracing is PER FUNCTION: a route that calls getDict() and is missing from
  // this map works perfectly under `next dev` (the file is just on disk) and
  // 500s in production. Every new dictionary-reading route needs an entry.
  //
  // This is no longer only a comment. `tests/unit/server/routes.test.ts` walks
  // each route's import graph and fails if one reaches lib/dict/load.ts without
  // a key here, and `pnpm smoke` hits every route on a built server. Both were
  // added because /api/examples and /api/recall shipped without their entries
  // and nothing but a person opening the page noticed (docs/deploy.md).
  //
  // `pnpm-workspace.yaml` rides along with the data on purpose: `dataDir()` in
  // lib/dict/load.ts finds the workspace root by walking up for that marker, and
  // a bundle that carries the dictionary but not the marker resolves to the
  // wrong directory and 503s anyway.
  outputFileTracingIncludes: {
    '/api/dict/**': ['../../data/**', '../../pnpm-workspace.yaml'],
    '/api/ask/**': ['../../data/**', '../../pnpm-workspace.yaml'],
    '/api/examples/**': ['../../data/**', '../../pnpm-workspace.yaml'],
    '/api/recall/**': ['../../data/**', '../../pnpm-workspace.yaml'],
  },
  async headers() {
    return [
      {
        // `public/` is served with a generic type for an unknown extension, and
        // some installability checks refuse a manifest that is not
        // application/manifest+json.
        source: '/manifest.webmanifest',
        headers: [{ key: 'Content-Type', value: 'application/manifest+json; charset=utf-8' }],
      },
      {
        // A worker at the root must be revalidated, or a bad one is permanent.
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'text/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default nextConfig;
