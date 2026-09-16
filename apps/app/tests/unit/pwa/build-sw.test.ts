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

import { appRoot } from '@/lib/server/roots';
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
const APP_ROOT = appRoot(import.meta.dirname);
const temporary: string[] = [];

afterEach(() => {
  while (temporary.length > 0) rmSync(temporary.pop() as string, { recursive: true, force: true });
});

/**
 * A tree shaped like a real build: a `public/` for the worker to be written
 * into, and a `dist/` that looks like what Vite emits — the entry document at
 * the root, the copied public files beside it, and hashed output under
 * `assets/`.
 */
function tree(): { publicDir: string; distDir: string } {
  const root = mkdtempSync(resolve(tmpdir(), 'tangram-sw-'));
  temporary.push(root);
  const publicDir = resolve(root, 'public');
  const distDir = resolve(root, 'dist');
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(resolve(distDir, 'icons'), { recursive: true });
  mkdirSync(resolve(distDir, 'assets'), { recursive: true });
  mkdirSync(resolve(distDir, '.vite'), { recursive: true });
  writeFileSync(resolve(distDir, 'index.html'), '<!doctype html><html lang="zh-Hans"><body>');
  writeFileSync(resolve(distDir, 'offline.html'), '<!doctype html><p>offline');
  writeFileSync(resolve(distDir, 'manifest.webmanifest'), '{"name":"Tangram"}');
  writeFileSync(resolve(distDir, 'icons/tangram.svg'), '<svg/>');
  writeFileSync(resolve(distDir, 'decomp.json'), '{"你":{}}');
  writeFileSync(resolve(distDir, 'assets/index-AAAA.js'), 'console.log(1)');
  writeFileSync(resolve(distDir, 'assets/index-BBBB.css'), 'body{}');
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
    const { distDir } = tree();
    expect(readBuildId(distDir)).toBe(readBuildId(distDir));
  });

  it('moves when index.html alone is touched — the document the worker IS', () => {
    // W3's review found this missing, and it is the worst version of the hole
    // the header describes: `/` is precached AND is what `shell()` serves for
    // every never-visited route offline, but Vite's manifest records only the
    // entry's emitted asset names, never the document's bytes. A changed title,
    // theme-color, `viewport-fit=cover` or `lang="zh-Hans"` left the stamp,
    // `sw.js` and therefore the browser's view of the worker byte-identical.
    const { distDir } = tree();
    const before = readBuildId(distDir);
    writeFileSync(
      resolve(distDir, 'index.html'),
      '<!doctype html><html lang="zh-Hans"><meta name="theme-color" content="#000"><body>',
    );
    expect(readBuildId(distDir)).not.toBe(before);
  });

  it('reads the manifest from the path vite.config.ts actually produces', () => {
    // `build.manifest` also accepts a string, which moves the file — and this
    // script would then silently stamp `dev` with only a warning. There is no
    // export to read the path off, so the coupling is asserted instead.
    const config = readFileSync(resolve(APP_ROOT, 'vite.config.ts'), 'utf8');
    expect(config, 'build.manifest must stay `true`, or VITE_MANIFEST is wrong').toMatch(
      /manifest:\s*true/,
    );
    expect(VITE_MANIFEST).toBe('.vite/manifest.json');
  });

  it('moves when Vite’s output moves', () => {
    const { distDir } = tree();
    const before = readBuildId(distDir);
    writeFileSync(
      resolve(distDir, VITE_MANIFEST),
      JSON.stringify({
        'src/main.tsx': { file: 'assets/index-ZZZZ.js', css: ['assets/index-BBBB.css'], isEntry: true },
      }),
    );
    expect(readBuildId(distDir)).not.toBe(before);
  });

  it('moves when offline.html alone is touched — the whole point', () => {
    // A stamp over the build manifest only leaves this unchanged, `activate`
    // purges nothing, and the stale precached offline page is served forever.
    const { distDir } = tree();
    const before = readBuildId(distDir);
    writeFileSync(resolve(distDir, 'offline.html'), '<!doctype html><p>offline, reworded');
    expect(readBuildId(distDir)).not.toBe(before);
  });

  it('moves for every other unhashed served file too, one at a time', () => {
    const { distDir } = tree();
    for (const [file, content] of [
      ['manifest.webmanifest', '{"name":"Tangram!"}'],
      ['icons/tangram.svg', '<svg><title>x</title></svg>'],
      ['decomp.json', '{"好":{}}'],
    ]) {
      const before = readBuildId(distDir);
      writeFileSync(resolve(distDir, file), content);
      expect(readBuildId(distDir), file).not.toBe(before);
    }
  });

  it('moves when a served file is renamed, though its bytes did not change', () => {
    // A rename changes which URLs the worker can serve, which is what the cache
    // name is about.
    const { distDir } = tree();
    const before = readBuildId(distDir);
    cpSync(resolve(distDir, 'icons/tangram.svg'), resolve(distDir, 'icons/logo.svg'));
    rmSync(resolve(distDir, 'icons/tangram.svg'));
    expect(readBuildId(distDir)).not.toBe(before);
  });

  it('does NOT hash the dictionary, its sidecars, the hashed assets, or sw.js', () => {
    const { distDir } = tree();
    const before = readBuildId(distDir);
    writeFileSync(resolve(distDir, 'dict-1-9.9.99999999.sqlite'), 'forty-three megabytes');
    writeFileSync(resolve(distDir, 'dict-1-9.9.99999999.sqlite.br'), 'seventeen megabytes');
    writeFileSync(resolve(distDir, 'dict-1-9.9.99999999.sqlite.br.json'), '{"quality":9}');
    writeFileSync(resolve(distDir, 'dict-manifest.json'), '{"file":"dict-1-9.9.99999999.sqlite"}');
    writeFileSync(resolve(distDir, 'sw.js'), '// the previous build’s worker');
    expect(readBuildId(distDir)).toBe(before);

    // Stated on the input list rather than only through the hash: two equal
    // hashes prove nothing about WHY they are equal.
    const labels = stampInputs(distDir).map((input) => input.label);
    expect(labels).not.toContain('dict-1-9.9.99999999.sqlite');
    expect(labels).not.toContain('dict-1-9.9.99999999.sqlite.br');
    expect(labels).not.toContain('dict-1-9.9.99999999.sqlite.br.json');
    expect(labels).not.toContain('dict-manifest.json');
    expect(labels).not.toContain('sw.js');
    // The hashed assets are named by the manifest, which IS an input; hashing
    // their bytes again would be megabytes for nothing.
    expect(labels).not.toContain('assets/index-AAAA.js');
    expect(labels).toContain('decomp.json');
    expect(labels).toContain('offline.html');
    expect(labels).toContain('index.html');
    expect(labels).toContain(VITE_MANIFEST);
  });

  it('names the exclusions in one place', () => {
    expect(isStampExcluded('sw.js')).toBe(true);
    expect(isStampExcluded('dict-1-1.3.20251213.sqlite')).toBe(true);
    expect(isStampExcluded('dict-1-1.3.20251213.sqlite.br')).toBe(true);
    expect(isStampExcluded('dict-manifest.json')).toBe(true);
    expect(isStampExcluded('dict-1-1.3.20251213.sqlite.br.json')).toBe(true);
    expect(isStampExcluded('assets/index-abc123.js')).toBe(true);
    expect(isStampExcluded('decomp.json')).toBe(false);
    expect(isStampExcluded('offline.html')).toBe(false);
    expect(isStampExcluded('index.html')).toBe(false);
    expect(isStampExcluded('icons/tangram-192.png')).toBe(false);
  });

  it('is a name a cache can carry', () => {
    const { distDir } = tree();
    expect(readBuildId(distDir)).toMatch(/^[a-f0-9]{16}$/);
  });

  it('falls back to the dev stamp when Vite has not built', () => {
    // `pnpm dev` never registers a worker, so a missing dist is not an error.
    expect(readBuildId('/nonexistent/dist')).toBe(DEV_BUILD_ID);
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
