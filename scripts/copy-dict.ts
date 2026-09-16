/**
 * Copies the generated dictionary artifacts into the app's `public/`
 * (docs/plans/web.md W2; docs/plans/wave-zero.md §6).
 *
 * `pnpm data` writes `data/dict-<schema>-<cedict>.sqlite`,
 * `data/dict-manifest.json` and `data/decomp.json` at the **workspace root**
 * and, per `data.md` D4, knows nothing about deployables — each deployable's
 * build copies out of that directory. Without this step the web build ends up
 * with a `DictStore`, an OPFS worker and a `fetch`, and no bytes to fetch.
 *
 * **Into `public/`, not into `dist/` after the fact.** `pnpm dev` and
 * `pnpm preview` serve `public/`, and `data.md` D4's criteria run against
 * exactly those two servers; a post-build copy into `dist/` would leave the dev
 * server with nothing.
 *
 * Three things this does that a `cp` would not:
 *
 *  1. **It cleans first.** The filename carries the version, so a stale copy is
 *     a *different* filename that the manifest no longer names — the build
 *     would ship two artifacts and point at one of them, and nothing would look
 *     wrong until the import. Every `dict-*.sqlite`, `dict-*.sqlite.br`,
 *     `dict-manifest.json` and `decomp.json` under `public/` is removed before
 *     anything is written.
 *  2. **It verifies the source against the manifest** — byte length and
 *     SHA-256 — before copying, and refuses an empty or half-built `data/`
 *     loudly rather than leaving a `dist/` whose manifest points at nothing.
 *     A missing copy and a stale copy fail differently and both look fine from
 *     the browser until the import throws.
 *  3. **It writes the pre-compressed `.br` sibling**, which is the half of the
 *     host rule that no configuration file can supply
 *     (`docs/plans/data.md` D4: 43 MB against ~15 MB is the difference between
 *     a first load a learner tolerates and one they abandon).
 *
 * **The compression quality is a measured trade, not a default.** On this
 * container, over the 43.2 MB artifact, with `node:zlib`:
 *
 * | quality | window | size | time |
 * |---|---|---|---|
 * | 9 | 2^24 | 16.9 MB | 15.5 s |
 * | 10 | 2^24 | 15.3 MB | 68.6 s |
 * | 11 | 2^24 | 14.7 MB | 110.9 s |
 *
 * 9 is the default because it is the only one that can sit in front of every
 * `vite build` without being resented; `TANGRAM_DICT_BROTLI_QUALITY=11` is the
 * release setting and buys 2.2 MB for 95 s — and it is honoured on a tree that
 * has already built, because the quality is part of the sibling's recorded
 * identity. Note that **no setting reproduces the 13.9 MB `data.md` D1
 * records**; 14.7 MB at q11 is the floor `node:zlib` reaches here. The measured
 * table and what it means for `web.md` W6's budget are in `HANDOFF.md` under
 * `web.md` W2–W4.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

import { MANIFEST_FILE, type DictManifest } from '../apps/app/lib/dict/artifact';
import { dataDir } from '../apps/app/lib/dict/load';
import { dirOf, workspaceRoot } from '../apps/app/lib/server/roots';

/** The extra file that is never in `data/`: the artifact's brotli sibling. */
export const BROTLI_SUFFIX = '.br';

/** `decomp.json`'s delivery is stated here because nothing else stated one. */
export const DECOMP_FILE = 'decomp.json';

export const DEFAULT_BROTLI_QUALITY = 9;

/** Everything this step may leave in `public/`, as gitignore-style patterns. */
export const PUBLIC_ARTIFACT_PATTERNS = [
  'dict-*.sqlite',
  'dict-*.sqlite.br',
  'dict-*.sqlite.br.json',
  MANIFEST_FILE,
  DECOMP_FILE,
] as const;

function isArtifactName(name: string): boolean {
  return (
    /^dict-.+\.sqlite(\.br(\.json)?)?$/.test(name) ||
    /^dict-.+\.sqlite(\.br)?\.tmp-\d+$/.test(name) ||
    name === MANIFEST_FILE ||
    name === DECOMP_FILE
  );
}

export class DictArtifactMissingError extends Error {
  override readonly name = 'DictArtifactMissingError';
  constructor(message: string) {
    super(`${message}\n  run \`pnpm data\` at the workspace root first.`);
  }
}

export interface CopyOptions {
  /** Where `pnpm data` wrote. Defaults to `dataDir()`, i.e. `TANGRAM_DATA_DIR`. */
  from?: string;
  /** The app's `public/`. */
  to?: string;
  quality?: number;
  log?: (line: string) => void;
}

export interface CopyResult {
  manifest: DictManifest;
  /** Files now in `public/`, in the order they were written. */
  written: string[];
  /** Compressed size, and whether this run had to produce it. */
  brotliBytes: number;
  brotliReused: boolean;
  /** The quality the sibling in `public/` was actually produced at. */
  brotliQuality: number;
}

/**
 * What is recorded beside the sibling, so the next run can tell whether it may
 * keep it.
 *
 * `quality` is here because it is NOT derivable from the bytes, and without it
 * `TANGRAM_DICT_BROTLI_QUALITY=11` silently no-ops on any tree that has already
 * built once — the operator believes they shipped 14.7 MB and shipped 16.9.
 */
interface BrotliSidecar {
  quality: number;
  /** The SOURCE artifact's digest, so a sibling can never outlive its artifact. */
  sha256: string;
  bytes: number;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readManifest(from: string): DictManifest {
  const path = resolve(from, MANIFEST_FILE);
  if (!existsSync(path)) {
    throw new DictArtifactMissingError(`copy-dict: no ${MANIFEST_FILE} in ${from}.`);
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as DictManifest;
  if (!manifest.file || typeof manifest.bytes !== 'number' || !manifest.sha256) {
    throw new DictArtifactMissingError(`copy-dict: ${path} is not a dictionary manifest.`);
  }
  return manifest;
}

export function copyDictArtifacts(options: CopyOptions = {}): CopyResult {
  const from = options.from ?? dataDir();
  const to = options.to ?? resolve(workspaceRoot(dirOf(import.meta.url)), 'apps/app/public');
  const log = options.log ?? (() => {});
  const quality =
    options.quality ?? Number(process.env.TANGRAM_DICT_BROTLI_QUALITY ?? DEFAULT_BROTLI_QUALITY);

  const manifest = readManifest(from);
  const source = resolve(from, manifest.file);
  if (!existsSync(source)) {
    throw new DictArtifactMissingError(
      `copy-dict: ${MANIFEST_FILE} names ${manifest.file}, which is not in ${from}.`,
    );
  }
  const size = statSync(source).size;
  if (size !== manifest.bytes) {
    throw new DictArtifactMissingError(
      `copy-dict: ${manifest.file} is ${size} bytes; the manifest says ${manifest.bytes}.`,
    );
  }
  const digest = sha256(source);
  if (digest !== manifest.sha256) {
    throw new DictArtifactMissingError(
      `copy-dict: ${manifest.file} hashes to ${digest}; the manifest says ${manifest.sha256}.`,
    );
  }
  const decompSource = resolve(from, DECOMP_FILE);
  if (!existsSync(decompSource)) {
    throw new DictArtifactMissingError(`copy-dict: no ${DECOMP_FILE} in ${from}.`);
  }

  mkdirSync(to, { recursive: true });

  // Reuse the brotli sibling only when it is provably the right bytes at the
  // right quality. Three things are checked and none of them is optional:
  //
  //  - the sidecar names THIS artifact's sha256, so a sibling cannot outlive
  //    the artifact it was made from;
  //  - the sidecar names the quality being asked for, or the release setting
  //    would silently no-op on a tree that had already built at the default;
  //  - the sibling **decompresses to the artifact**. It is written in one
  //    16.9 MB `writeFileSync`, so a build killed mid-write, a full disk or an
  //    interrupted `pnpm dev` leaves a truncated file — which would then be
  //    carried forward for ever and served under a content-addressed name with
  //    `immutable` on it for a year. Decompressing costs ~0.2 s and is the only
  //    check that can tell a good sibling from a plausible one.
  const brotliName = `${manifest.file}${BROTLI_SUFFIX}`;
  const brotliPath = resolve(to, brotliName);
  const sidecarPath = `${brotliPath}.json`;
  const carried = reusable(brotliPath, sidecarPath, manifest, quality);

  for (const name of readdirSync(to)) {
    if (isArtifactName(name)) rmSync(resolve(to, name), { force: true });
  }

  const written: string[] = [];
  copyFileSync(source, resolve(to, manifest.file));
  written.push(manifest.file);
  copyFileSync(resolve(from, MANIFEST_FILE), resolve(to, MANIFEST_FILE));
  written.push(MANIFEST_FILE);
  copyFileSync(decompSource, resolve(to, DECOMP_FILE));
  written.push(DECOMP_FILE);

  let brotli: Buffer;
  if (carried) {
    brotli = carried;
    log(`copy-dict: reusing the q${quality} brotli sibling (${(brotli.length / 1e6).toFixed(1)} MB)`);
  } else {
    const started = Date.now();
    brotli = brotliCompressSync(readFileSync(source), {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: quality,
        [constants.BROTLI_PARAM_LGWIN]: 24,
        [constants.BROTLI_PARAM_SIZE_HINT]: manifest.bytes,
      },
    });
    log(
      `copy-dict: brotli q${quality} ${(brotli.length / 1e6).toFixed(1)} MB in ${(
        (Date.now() - started) / 1000
      ).toFixed(1)} s`,
    );
  }
  // Atomically: a half-written 16.9 MB sibling beside an intact artifact is
  // exactly what the reuse check above exists to refuse, and the cheapest way
  // to refuse it is never to create one.
  writeAtomic(brotliPath, brotli);
  writeAtomic(sidecarPath, Buffer.from(JSON.stringify(
    { quality, sha256: manifest.sha256, bytes: manifest.bytes } satisfies BrotliSidecar,
  )));
  written.push(brotliName, `${brotliName}.json`);

  log(
    `copy-dict: ${manifest.file} (${(manifest.bytes / 1e6).toFixed(1)} MB), ${MANIFEST_FILE}, ` +
      `${DECOMP_FILE} and ${brotliName} → ${to}`,
  );
  return {
    manifest,
    written,
    brotliBytes: brotli.length,
    brotliReused: Boolean(carried),
    brotliQuality: quality,
  };
}

/** The sibling's bytes, if it is provably this artifact's at this quality. */
function reusable(
  brotliPath: string,
  sidecarPath: string,
  manifest: DictManifest,
  quality: number,
): Buffer | undefined {
  if (!existsSync(brotliPath) || !existsSync(sidecarPath)) return undefined;
  let sidecar: BrotliSidecar;
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as BrotliSidecar;
  } catch {
    return undefined;
  }
  if (sidecar.quality !== quality || sidecar.sha256 !== manifest.sha256) return undefined;
  try {
    const bytes = readFileSync(brotliPath);
    const decoded = brotliDecompressSync(bytes);
    if (decoded.byteLength !== manifest.bytes) return undefined;
    if (createHash('sha256').update(decoded).digest('hex') !== manifest.sha256) return undefined;
    return bytes;
  } catch {
    // A truncated or corrupt sibling throws here rather than being believed.
    return undefined;
  }
}

/** Write through a temporary name in the same directory, then rename. */
function writeAtomic(path: string, bytes: Buffer): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, path);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  // `--optional` is for `pnpm dev` only. A build that ships a `dist/` with no
  // dictionary is a broken deployment and must fail; a dev server on a fresh
  // clone that has not run `pnpm data` yet should warn and start, because
  // "missing data is a banner, not a crash" (CLAUDE.md) and the banner is what
  // the developer is about to see.
  const optional = process.argv.includes('--optional');
  try {
    copyDictArtifacts({ log: (line) => console.log(line) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (optional && error instanceof DictArtifactMissingError) {
      console.warn(`copy-dict: continuing without the dictionary.\n${message}`);
    } else {
      console.error(message);
      process.exit(1);
    }
  }
}
