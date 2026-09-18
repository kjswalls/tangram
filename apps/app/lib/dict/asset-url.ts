/**
 * Where the dictionary's build-output files are, for a browser (docs/plans/data.md D4).
 *
 * `web.md` W2 copies `dict-<schema>-<cedict>.sqlite`, `dict-manifest.json` and
 * `decomp.json` into `apps/app/public/`, so they land at the root of the build
 * output under their own names — but "the root of the build output" is not
 * always `/`. `vite.config.ts` documents `vite build --base=/sub/` as a
 * supported separate invocation and `src/main.tsx` already derives the router's
 * `basename` from it, so a hard-coded `/dict-manifest.json` would reach outside
 * a subpath deploy and (under an SPA fallback) come back as HTML with a 200 —
 * which the dictionary would then report as `corrupt`, truthfully and
 * uselessly.
 *
 * **Its own module rather than `artifact.ts`, and that is not tidiness.**
 * `artifact.ts` is imported by `scripts/build-data.ts` and `scripts/verify-data.ts`
 * under Node, and this module has no business being pulled into a build script.
 *
 * **`import.meta.env` is read defensively, because a bundler is not the only
 * thing that loads this file.** Vite substitutes it at build time and Vitest
 * defines it, but Playwright's spec loader imports the dictionary layer into
 * plain Node to run D2's store as a differential oracle — and there
 * `import.meta.env` is `undefined`, so a direct property read throws at module
 * scope and takes the whole suite with it. It did, once.
 */
export function assetUrl(file: string): string {
  const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
  const base = env?.BASE_URL || '/';
  return `${base.endsWith('/') ? base : `${base}/`}${file}`;
}
