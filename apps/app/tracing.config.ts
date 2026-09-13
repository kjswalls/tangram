/**
 * The `outputFileTracingIncludes` map, as a bare object literal.
 *
 * It lived in `next.config.ts` until W1 deleted that file. Keeping the file was
 * not an option even as inert data: its first line was
 * `import type { NextConfig } from 'next'`, so once `next` left package.json
 * that type import could not resolve and both `tsc` and vitest's module graph
 * would fail on it.
 *
 * The rule it encodes has not changed and is still live, because
 * `/api/dict/*`, `/api/ask`, `/api/examples` and `/api/recall` still read
 * `data/` from disk in the dev and preview adapter, and `docs/deploy.md`'s
 * deployment still traces them. It exists because `/api/examples` and
 * `/api/recall` once shipped without their entries and only a human opening the
 * page noticed.
 *
 * **Delete this file and its test in the same commit as the thing they
 * guarded** — that is, when `data.md` D6 deletes the dictionary routes and
 * `backend.md` owns the remaining three. Silently dropping the test is the
 * failure this paragraph exists to prevent.
 *
 * The two numbers that make the values right are recorded here because nothing
 * else states them: the globs are resolved by Next with cwd set to the **Next
 * project directory** (`apps/app/`), and `data/` is two levels above it at the
 * workspace root (docs/plans/wave-zero.md §1). `pnpm-workspace.yaml` rides
 * along because `dataDir()` finds that root by walking up for the marker, so a
 * bundle with the dictionary and no marker resolves to the wrong directory.
 */
export const OUTPUT_FILE_TRACING_INCLUDES: Readonly<Record<string, readonly string[]>> = {
  '/api/dict/**': ['../../data/**', '../../pnpm-workspace.yaml'],
  '/api/ask/**': ['../../data/**', '../../pnpm-workspace.yaml'],
  '/api/examples/**': ['../../data/**', '../../pnpm-workspace.yaml'],
  '/api/recall/**': ['../../data/**', '../../pnpm-workspace.yaml'],
};
