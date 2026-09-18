/**
 * The dictionary's web delivery, from `data/` into the app's `public/`
 * (docs/plans/web.md W2; docs/plans/wave-zero.md §6).
 *
 * Two failures this is here for, and they fail differently:
 *
 *  - **A missing copy.** The build ships a `dist/` whose manifest points at
 *    nothing. The copy step must refuse rather than produce that.
 *  - **A stale copy.** The filename carries the version, so a stale copy is a
 *    *different* filename the manifest no longer names. `public/` ends up with
 *    two artifacts and the manifest names one of them — and both look fine from
 *    the browser until the import throws.
 *
 * Every case here runs against a temporary directory pair, except the last,
 * which asserts the bytes in the real `apps/app/public/` against the real
 * `data/dict-manifest.json` when a build has run.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { MANIFEST_FILE, type DictManifest } from '@/lib/dict/artifact';
import { appRoot, workspaceRoot } from '@/lib/server/roots';
import {
  copyDictArtifacts,
  DictArtifactMissingError,
  DECOMP_FILE,
} from '../../../../../scripts/copy-dict';

const APP = appRoot(__dirname);
const PUBLIC = resolve(APP, 'public');
const DATA = resolve(workspaceRoot(APP), 'data');

const temporary: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'tangram-copy-'));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  while (temporary.length > 0) rmSync(temporary.pop() as string, { recursive: true, force: true });
});

/** A tiny stand-in artifact: the copy step cares about identity, not content. */
function fakeData(overrides: Partial<DictManifest> = {}): { from: string; manifest: DictManifest } {
  const from = scratch();
  const bytes = Buffer.from('not really a database, but it hashes');
  const manifest: DictManifest = {
    file: 'dict-1-9.9.99999999.sqlite',
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    schemaVersion: 1,
    dictVersion: '9.9.99999999',
    ...overrides,
  };
  writeFileSync(resolve(from, 'dict-1-9.9.99999999.sqlite'), bytes);
  writeFileSync(resolve(from, DECOMP_FILE), JSON.stringify({ 你: {} }));
  writeFileSync(resolve(from, MANIFEST_FILE), JSON.stringify(manifest));
  return { from, manifest };
}

describe('copying the artifacts into public/', () => {
  it('copies all three, and writes the brotli sibling', () => {
    const { from, manifest } = fakeData();
    const to = scratch();
    const result = copyDictArtifacts({ from, to, quality: 1 });

    expect(readdirSync(to).sort()).toEqual(
      [
        manifest.file,
        `${manifest.file}.br`,
        `${manifest.file}.br.json`,
        MANIFEST_FILE,
        DECOMP_FILE,
      ].sort(),
    );
    expect(statSync(resolve(to, manifest.file)).size).toBe(manifest.bytes);
    // The `.br` must be the same bytes, or a negotiated response is a
    // different dictionary under a content-addressed name that says it cannot
    // be.
    expect(brotliDecompressSync(readFileSync(resolve(to, `${manifest.file}.br`)))).toEqual(
      readFileSync(resolve(from, manifest.file)),
    );
    expect(result.brotliReused).toBe(false);
  });

  it('cleans the previous version out first — a stale copy is a silent failure', () => {
    const { from, manifest } = fakeData();
    const to = scratch();
    writeFileSync(resolve(to, 'dict-1-1.0.20200101.sqlite'), 'the last build');
    writeFileSync(resolve(to, 'dict-1-1.0.20200101.sqlite.br'), 'the last build, smaller');

    copyDictArtifacts({ from, to, quality: 1 });

    const left = readdirSync(to);
    expect(left).not.toContain('dict-1-1.0.20200101.sqlite');
    expect(left).not.toContain('dict-1-1.0.20200101.sqlite.br');
    expect(left).toContain(manifest.file);
  });

  it('leaves everything else in public/ alone', () => {
    const { from } = fakeData();
    const to = scratch();
    writeFileSync(resolve(to, 'offline.html'), '<!doctype html>');
    mkdirSync(resolve(to, 'icons'));

    copyDictArtifacts({ from, to, quality: 1 });

    expect(existsSync(resolve(to, 'offline.html'))).toBe(true);
    expect(existsSync(resolve(to, 'icons'))).toBe(true);
  });

  it('refuses an empty data/ loudly rather than shipping a dist that points at nothing', () => {
    const to = scratch();
    expect(() => copyDictArtifacts({ from: scratch(), to, quality: 1 })).toThrow(
      DictArtifactMissingError,
    );
    expect(() => copyDictArtifacts({ from: scratch(), to, quality: 1 })).toThrow(/pnpm data/);
    expect(readdirSync(to)).toEqual([]);
  });

  it('refuses a manifest whose artifact is not there', () => {
    const { from, manifest } = fakeData();
    rmSync(resolve(from, manifest.file));
    expect(() => copyDictArtifacts({ from, to: scratch(), quality: 1 })).toThrow(/is not in/);
  });

  it('refuses an artifact whose length disagrees with the manifest', () => {
    const { from } = fakeData({ bytes: 999_999 });
    expect(() => copyDictArtifacts({ from, to: scratch(), quality: 1 })).toThrow(/the manifest says/);
  });

  it('refuses an artifact whose sha256 disagrees — the same length, different bytes', () => {
    const { from, manifest } = fakeData();
    writeFileSync(resolve(from, manifest.file), 'x'.repeat(manifest.bytes));
    expect(() => copyDictArtifacts({ from, to: scratch(), quality: 1 })).toThrow(/hashes to/);
  });

  it('refuses a data/ with no decomp.json — its delivery is stated, not optional', () => {
    const { from } = fakeData();
    rmSync(resolve(from, DECOMP_FILE));
    expect(() => copyDictArtifacts({ from, to: scratch(), quality: 1 })).toThrow(/decomp\.json/);
  });

  it('reuses the brotli sibling only when it belongs to this exact artifact', () => {
    const { from } = fakeData();
    const to = scratch();
    copyDictArtifacts({ from, to, quality: 1 });
    expect(copyDictArtifacts({ from, to, quality: 1 }).brotliReused).toBe(true);
  });

  it('does NOT reuse it at a different quality — the release setting is not a no-op', () => {
    // `TANGRAM_DICT_BROTLI_QUALITY=11` is documented as the release trade
    // (2.2 MB for 95 s). Keyed only on the artifact, it silently kept the q9
    // bytes on any tree that had already built once, and the operator's only
    // clue was the absence of a log line.
    const { from } = fakeData();
    const to = scratch();
    copyDictArtifacts({ from, to, quality: 1 });
    const bumped = copyDictArtifacts({ from, to, quality: 11 });
    expect(bumped.brotliReused).toBe(false);
    expect(bumped.brotliQuality).toBe(11);
    // …and having recompressed at 11, a second q11 run may reuse.
    expect(copyDictArtifacts({ from, to, quality: 11 }).brotliReused).toBe(true);
  });

  it('does NOT reuse a TRUNCATED sibling, which is what a killed build leaves', () => {
    // The check that matters most, because the result would be served under a
    // content-addressed name with `immutable` on it for a year. Nothing about a
    // truncated file looks wrong from the outside — only decompressing it does.
    const { from, manifest } = fakeData();
    const to = scratch();
    copyDictArtifacts({ from, to, quality: 1 });
    const sibling = resolve(to, `${manifest.file}.br`);
    writeFileSync(sibling, readFileSync(sibling).subarray(0, 4));

    const again = copyDictArtifacts({ from, to, quality: 1 });
    expect(again.brotliReused).toBe(false);
    expect(brotliDecompressSync(readFileSync(sibling))).toEqual(
      readFileSync(resolve(from, manifest.file)),
    );
  });

  it('does NOT reuse a sibling whose sidecar names a different artifact', () => {
    const { from, manifest } = fakeData();
    const to = scratch();
    copyDictArtifacts({ from, to, quality: 1 });
    writeFileSync(
      resolve(to, `${manifest.file}.br.json`),
      JSON.stringify({ quality: 1, sha256: 'f'.repeat(64), bytes: manifest.bytes }),
    );
    expect(copyDictArtifacts({ from, to, quality: 1 }).brotliReused).toBe(false);
  });

  it('does NOT reuse a sibling with no sidecar at all', () => {
    const { from, manifest } = fakeData();
    const to = scratch();
    copyDictArtifacts({ from, to, quality: 1 });
    rmSync(resolve(to, `${manifest.file}.br.json`));
    expect(copyDictArtifacts({ from, to, quality: 1 }).brotliReused).toBe(false);
  });
});

describe('the bytes actually in apps/app/public/', () => {
  const manifestPath = resolve(DATA, MANIFEST_FILE);
  const built = existsSync(manifestPath);
  const manifest = built ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as DictManifest) : null;
  const copied = manifest ? resolve(PUBLIC, manifest.file) : '';

  it.skipIf(!built)('are byte-identical to the artifact the manifest names', () => {
    // NOT skipped when the copy is missing: `public/` holding a stale artifact
    // the manifest no longer names is the exact failure this file's header
    // describes, and skipping on it would hide the staleness guard below in
    // precisely the state it exists for.
    expect(existsSync(copied), `${copied} is missing — run pnpm build`).toBe(true);
    const bytes = readFileSync(copied);
    expect(bytes.byteLength).toBe((manifest as DictManifest).bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      (manifest as DictManifest).sha256,
    );
  });

  it.skipIf(!built)('carry exactly one artifact, never two', () => {
    const artifacts = readdirSync(PUBLIC).filter((name) => /^dict-.+\.sqlite$/.test(name));
    expect(artifacts).toEqual([(manifest as DictManifest).file]);
  });
});
