import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The dictionary loader reads data/*.json from disk at request time, so the
  // JSON must be traced into the serverless bundle for the routes that use it.
  outputFileTracingIncludes: {
    '/api/dict/**': ['./data/**'],
    '/api/ask/**': ['./data/**'],
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
