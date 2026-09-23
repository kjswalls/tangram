/**
 * What a browser keys its copy of the dictionary on (`lib/dict/artifact.ts`).
 *
 * The filename carries the schema and the CC-CEDICT snapshot and nothing else,
 * so a rebuild that changes the bytes — the HSK-band reading order, an upstream
 * HSK or jieba move — keeps it. The OPFS pool name and the fetch URL therefore
 * carry the manifest's sha256 as well; `tests/e2e/d/dict-wasm.spec.ts` proves
 * the upgrade end to end, and these pin the two names it depends on.
 */
import { describe, expect, it } from 'vitest';

import { artifactFetchPath, artifactPoolName } from '@/lib/dict/artifact';

const FILE = 'dict-1-1.3.20251213.sqlite';
const OLD = '685ecf4c5be76933e3fdbe8a5abaae6db9774147d29e7a1b0e910f55d8a65f58';
const NEW = 'cb893d8856faa18dcac521ebb81e70276ca19ab707d0ab6f161dc3d9dca6a3c3';

/** The worker's sweep pattern, copied: a pool name it cannot see is never cleaned up. */
const ARTIFACT_PATTERN = /^\/dict-\d+-.*\.sqlite$/;

describe('artifactPoolName', () => {
  it('differs for two builds under one filename', () => {
    expect(artifactPoolName({ file: FILE, sha256: OLD })).not.toBe(
      artifactPoolName({ file: FILE, sha256: NEW }),
    );
    expect(artifactPoolName({ file: FILE, sha256: NEW })).toBe(
      '/dict-1-1.3.20251213-cb893d8856faa18d.sqlite',
    );
  });

  it('is never the bare filename every browser stored before it, so that file is swept', () => {
    const bare = `/${FILE}`;
    expect(artifactPoolName({ file: FILE, sha256: NEW })).not.toBe(bare);
    expect(bare).toMatch(ARTIFACT_PATTERN);
    expect(artifactPoolName({ file: FILE, sha256: NEW })).toMatch(ARTIFACT_PATTERN);
  });

  it('falls back to the bare filename for a manifest with no digest', () => {
    expect(artifactPoolName({ file: FILE, sha256: '' })).toBe(`/${FILE}`);
  });
});

describe('artifactFetchPath', () => {
  it('keeps the path the host rules match on and changes the URL with the bytes', () => {
    const path = artifactFetchPath({ file: FILE, sha256: NEW });
    const url = new URL(path, 'https://tangram.example/');
    expect(url.pathname).toBe(`/${FILE}`);
    expect(url.searchParams.get('sha256')).toBe(NEW);
    expect(artifactFetchPath({ file: FILE, sha256: OLD })).not.toBe(path);
  });

  it('falls back to the bare filename for a manifest with no digest', () => {
    expect(artifactFetchPath({ file: FILE, sha256: '' })).toBe(FILE);
  });
});
