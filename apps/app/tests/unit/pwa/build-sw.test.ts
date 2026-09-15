/**
 * The generator that binds the worker's cache name to the build
 * (`scripts/build-sw.ts`, docs/plans/web.md W3).
 *
 * The bug it closes is storage, not correctness: `activate` deletes every cache
 * that is not the current one, and while the current one was a hand-bumped
 * literal a routine build purged nothing — every deploy's hashed chunks stayed
 * in the cache. W1 reintroduced it by accident, because `.next/BUILD_ID` was
 * gone and the fallback stamped every build `dev`.
 *
 * So what is asserted here is the *stamp*, and mostly its second half. Vite's
 * build manifest covers only the module graph; files copied out of `public/`
 * keep their authored names and appear in no manifest. A stamp over the
 * manifest alone would let `offline.html` change with the cache name unchanged,
 * which is the mistake this phase is most likely to make and the one
 * `.next/BUILD_ID` did not have.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BUILD_ID_PLACEHOLDER,
  buildServiceWorker,
  computeStamp,
  DEV_BUILD_ID,
  isStampExcluded,
  normalizeBuildId,
  PRECACHE_PLACEHOLDER,
  precacheList,
  readBuildId,
  renderServiceWorker,
  stampInputs,
  TEMPLATE_PATH,
  VITE_MANIFEST,
} from '../../../../../scripts/build-sw';

const template = readFileSync(TEMPLATE_PATH, 'utf8');
const temporary: string[] = [];

afterEach(() => {
  while (temporary.length > 0) rmSync(temporary.pop() as string, { recursive: true, force: true });
});

/** A tree shaped like the real one: a `public/` and a built `dist/`. */
function tree(): { publicDir: string; distDir: string } {
  const root = mkdtempSync(resolve(tmpdir(), 'tangram-sw-'));
  temporary.push(root);
  const publicDir = resolve(root, 'public');
  const distDir = resolve(root, 'dist');
  mkdirSync(resolve(publicDir, 'icons'), { recursive: true });
  mkdirSync(resolve(distDir, '.vite'), { recursive: true });
  writeFileSync(resolve(publicDir, 'offline.html'), '<!doctype html><p>offline');
  writeFileSync(resolve(publicDir, 'manifest.webmanifest'), '{"name":"Tangram"}');
  writeFileSync(resolve(publicDir, 'icons/tangram.svg'), '<svg/>');
  writeFileSync(resolve(publicDir, 'decomp.json'), '{"你":{}}');
  writeFileSync(
    resolve(distDir, VITE_MANIFEST),
    JSON.stringify({
      'src/main.tsx': { file: 'assets/index-AAAA.js', css: ['assets/index-BBBB.css'], isEntry: true },
      'lib/other.ts': { file: 'assets/other-CCCC.js' },
    }),
  );
  return { publicDir, distDir };
}

describe('the stamp', () => {
  it('is stable: the same tree twice gives the same name', () => {
    // Half the argument for a content hash. `.next/BUILD_ID` changed on every
    // build, so a rebuild with identical output purged a cache for nothing.
    const { publicDir, distDir } = tree();
    expect(readBuildId(publicDir, distDir)).toBe(readBuildId(publicDir, distDir));
  });

  it('moves when Vite’s output moves', () => {
    const { publicDir, distDir } = tree();
    const before = readBuildId(publicDir, distDir);
    writeFileSync(
      resolve(distDir, VITE_MANIFEST),
      JSON.stringify({
        'src/main.tsx': { file: 'assets/index-ZZZZ.js', css: ['assets/index-BBBB.css'], isEntry: true },
      }),
    );
    expect(readBuildId(publicDir, distDir)).not.toBe(before);
  });

  it('moves when public/offline.html alone is touched — the whole point', () => {
    // A stamp over the build manifest only leaves this unchanged, `activate`
    // purges nothing, and the stale precached offline page is served forever.
    const { publicDir, distDir } = tree();
    const before = readBuildId(publicDir, distDir);
    writeFileSync(resolve(publicDir, 'offline.html'), '<!doctype html><p>offline, reworded');
    expect(readBuildId(publicDir, distDir)).not.toBe(before);
  });

  it('moves for every other unhashed public file too, one at a time', () => {
    const { publicDir, distDir } = tree();
    for (const [file, content] of [
      ['manifest.webmanifest', '{"name":"Tangram!"}'],
      ['icons/tangram.svg', '<svg><title>x</title></svg>'],
      ['decomp.json', '{"好":{}}'],
    ]) {
      const before = readBuildId(publicDir, distDir);
      writeFileSync(resolve(publicDir, file), content);
      expect(readBuildId(publicDir, distDir), file).not.toBe(before);
    }
  });

  it('moves when a public file is renamed, though its bytes did not change', () => {
    // A rename changes which URLs the worker can serve, which is what the cache
    // name is about.
    const { publicDir, distDir } = tree();
    const before = readBuildId(publicDir, distDir);
    cpSync(resolve(publicDir, 'icons/tangram.svg'), resolve(publicDir, 'icons/logo.svg'));
    rmSync(resolve(publicDir, 'icons/tangram.svg'));
    expect(readBuildId(publicDir, distDir)).not.toBe(before);
  });

  it('does NOT hash the dictionary, its brotli sibling, its manifest, or sw.js', () => {
    const { publicDir, distDir } = tree();
    const before = readBuildId(publicDir, distDir);
    writeFileSync(resolve(publicDir, 'dict-1-9.9.99999999.sqlite'), 'forty-three megabytes');
    writeFileSync(resolve(publicDir, 'dict-1-9.9.99999999.sqlite.br'), 'seventeen megabytes');
    writeFileSync(resolve(publicDir, 'dict-manifest.json'), '{"file":"dict-1-9.9.99999999.sqlite"}');
    writeFileSync(resolve(publicDir, 'sw.js'), '// the previous build’s worker');
    expect(readBuildId(publicDir, distDir)).toBe(before);

    // Stated on the input list rather than only through the hash: two equal
    // hashes prove nothing about WHY they are equal.
    const labels = stampInputs(publicDir, distDir).map((input) => input.label);
    expect(labels).not.toContain('public/dict-1-9.9.99999999.sqlite');
    expect(labels).not.toContain('public/dict-1-9.9.99999999.sqlite.br');
    expect(labels).not.toContain('public/dict-manifest.json');
    expect(labels).not.toContain('public/sw.js');
    expect(labels).toContain('public/decomp.json');
    expect(labels).toContain('public/offline.html');
    expect(labels).toContain(VITE_MANIFEST);
  });

  it('names the exclusions in one place', () => {
    expect(isStampExcluded('sw.js')).toBe(true);
    expect(isStampExcluded('dict-1-1.3.20251213.sqlite')).toBe(true);
    expect(isStampExcluded('dict-1-1.3.20251213.sqlite.br')).toBe(true);
    expect(isStampExcluded('dict-manifest.json')).toBe(true);
    expect(isStampExcluded('decomp.json')).toBe(false);
    expect(isStampExcluded('offline.html')).toBe(false);
    expect(isStampExcluded('icons/tangram-192.png')).toBe(false);
  });

  it('is a name a cache can carry', () => {
    const { publicDir, distDir } = tree();
    expect(readBuildId(publicDir, distDir)).toMatch(/^[a-f0-9]{16}$/);
  });

  it('falls back to the dev stamp when Vite has not built', () => {
    // `pnpm dev` never registers a worker, so a missing dist is not an error.
    const { publicDir } = tree();
    expect(readBuildId(publicDir, '/nonexistent/dist')).toBe(DEV_BUILD_ID);
  });

  it('hashes the label beside the bytes, so two files cannot swap unnoticed', () => {
    const a = [
      { label: 'public/a', sha256: '11' },
      { label: 'public/b', sha256: '22' },
    ];
    const b = [
      { label: 'public/a', sha256: '22' },
      { label: 'public/b', sha256: '11' },
    ];
    expect(computeStamp(a)).not.toBe(computeStamp(b));
  });
});

describe('the precache list', () => {
  it('is the document, the offline page, and this build’s entry assets', () => {
    const { distDir } = tree();
    expect(precacheList(distDir)).toEqual([
      '/',
      '/offline.html',
      '/assets/index-AAAA.js',
      '/assets/index-BBBB.css',
    ]);
  });

  it('takes the ENTRY’s assets, not every chunk in the manifest', () => {
    // Precaching every emitted chunk is what a PWA plugin does by default and
    // is the wrong shape here: a lazily-imported chunk is fetched when it is
    // needed, and precaching it makes the install pay for it.
    expect(precacheList(tree().distDir)).not.toContain('/assets/other-CCCC.js');
  });

  it('degrades to the two documents when there is no build manifest', () => {
    expect(precacheList('/nonexistent/dist')).toEqual(['/', '/offline.html']);
  });

  it('has no per-route entry left to re-derive when core.md C7 collapses the table', () => {
    // It was the seven nav routes; under the SPA fallback those were seven
    // copies of one document.
    for (const route of ['/lookup', '/review', '/read', '/lists', '/stats', '/settings']) {
      expect(precacheList(tree().distDir)).not.toContain(route);
    }
  });
});

describe('rendering the worker', () => {
  it('substitutes both placeholders and nothing else', () => {
    const worker = renderServiceWorker(template, 'aBcD1234', ['/', '/offline.html']);
    expect(worker).toContain("const VERSION = 'aBcD1234'");
    expect(worker).toContain('const SHELL = ["/","/offline.html"]');
    expect(worker).not.toContain(BUILD_ID_PLACEHOLDER);
    expect(worker).not.toContain(PRECACHE_PLACEHOLDER);
    // Everything else is the template verbatim: this script substitutes, it
    // does not rewrite the policy.
    expect(
      worker
        .replace("'aBcD1234'", `'${BUILD_ID_PLACEHOLDER}'`)
        .replace('["/","/offline.html"]', PRECACHE_PLACEHOLDER),
    ).toBe(template);
  });

  it('refuses a template that has lost either placeholder', () => {
    expect(() => renderServiceWorker("const VERSION = 'v2';", 'abc', [])).toThrow(
      /__TANGRAM_BUILD_ID__/,
    );
    expect(() =>
      renderServiceWorker(`const VERSION = '${BUILD_ID_PLACEHOLDER}';`, 'abc', []),
    ).toThrow(/__TANGRAM_PRECACHE__/);
  });

  it('refuses a stamp that would not survive being quoted', () => {
    for (const bad of ["a'; caches.delete('x", 'two words', 'line\nbreak', '']) {
      expect(() => normalizeBuildId(bad)).toThrow(/build id/);
    }
    expect(normalizeBuildId(' Xy_-09 \n')).toBe('Xy_-09');
  });
});

describe('writing it', () => {
  it('writes BOTH public/sw.js and dist/sw.js', () => {
    // `vite build` runs first and copies `public/` — including the PREVIOUS
    // build's sw.js — into `dist/`. Writing only `public/` would leave the
    // served worker one build behind: stamped for output it does not describe.
    const { publicDir, distDir } = tree();
    writeFileSync(resolve(publicDir, 'sw.js'), '// stale');
    writeFileSync(resolve(distDir, 'sw.js'), '// stale, and this is the one served');

    const result = buildServiceWorker({ publicDir, distDir });

    expect(result.written).toHaveLength(2);
    for (const path of result.written) {
      const worker = readFileSync(path, 'utf8');
      expect(worker).toContain(`const VERSION = '${result.buildId}'`);
      expect(worker).not.toContain(BUILD_ID_PLACEHOLDER);
    }
    expect(readFileSync(resolve(distDir, 'sw.js'), 'utf8')).toBe(
      readFileSync(resolve(publicDir, 'sw.js'), 'utf8'),
    );
  });

  it('writes only public/sw.js when there is no dist', () => {
    const { publicDir } = tree();
    const result = buildServiceWorker({ publicDir, distDir: '/nonexistent/dist' });
    expect(result.written).toEqual([resolve(publicDir, 'sw.js')]);
    expect(result.buildId).toBe(DEV_BUILD_ID);
  });

  it('does not let its own output feed the next stamp', () => {
    const { publicDir, distDir } = tree();
    const first = buildServiceWorker({ publicDir, distDir });
    const second = buildServiceWorker({ publicDir, distDir });
    expect(second.buildId).toBe(first.buildId);
  });
});
