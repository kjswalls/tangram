import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The dictionary loader reads data/*.json from disk at request time, so the
  // JSON must be traced into the serverless bundle for the routes that use it.
  // Tracing is declared PER ROUTE — Vercel then bundles the routes into one
  // shared function whose files are the union of their traces (docs/deploy.md
  // §5), so a route that calls getDict() and is missing from this map works
  // perfectly under `next dev` (the file is just on disk) and ships to
  // production with no claim on data/ of its own, living off whichever routes
  // it was grouped with. Every new dictionary-reading route needs an entry.
  //
  // This is no longer only a comment. `tests/unit/server/routes.test.ts` walks
  // each route's import graph and fails if one reaches lib/dict/load.ts without
  // a key here, and `pnpm smoke` hits every route on a built server. Both were
  // added because /api/examples and /api/recall shipped without their entries
  // and nothing but a person opening the page noticed (docs/deploy.md).
  outputFileTracingIncludes: {
    '/api/dict/**': ['./data/**'],
    '/api/ask/**': ['./data/**'],
    '/api/examples/**': ['./data/**'],
    '/api/recall/**': ['./data/**'],
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
