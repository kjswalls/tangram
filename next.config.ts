import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The dictionary loader reads data/*.json from disk at request time, so the
  // JSON must be traced into the serverless bundle for the routes that use it.
  outputFileTracingIncludes: {
    '/api/dict/**': ['./data/**'],
    '/api/ask/**': ['./data/**'],
  },
};

export default nextConfig;
