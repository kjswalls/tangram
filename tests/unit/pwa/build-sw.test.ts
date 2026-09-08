/**
 * The generator that binds the worker's cache name to the build
 * (`scripts/build-sw.ts`).
 *
 * The bug it closes is storage, not correctness: `activate` deletes every cache
 * that is not the current one, and while the current one was a hand-bumped
 * literal a routine `next build` purged nothing — every deploy's hashed chunks
 * stayed in the cache. What has to hold is that the served worker's version
 * *changes when the build changes*, and that a template which has lost its
 * placeholder is a build error rather than a worker frozen at one cache name.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  BUILD_ID_PLACEHOLDER,
  DEV_BUILD_ID,
  normalizeBuildId,
  readBuildId,
  renderServiceWorker,
  TEMPLATE_PATH,
} from '../../../scripts/build-sw';

const template = readFileSync(TEMPLATE_PATH, 'utf8');

describe('build-sw', () => {
  it('stamps the build id into the cache name', () => {
    const worker = renderServiceWorker(template, 'aBcD1234');

    expect(worker).toContain("const VERSION = 'aBcD1234'");
    expect(worker).not.toContain(BUILD_ID_PLACEHOLDER);
    // Everything else is the template verbatim: this script substitutes, it
    // does not rewrite the policy.
    expect(worker.replace("'aBcD1234'", `'${BUILD_ID_PLACEHOLDER}'`)).toBe(template);
  });

  it('gives two builds two cache names, so activate can purge', () => {
    const first = renderServiceWorker(template, 'build-one');
    const second = renderServiceWorker(template, 'build-two');
    expect(first).not.toBe(second);
  });

  it('refuses a template with no placeholder rather than freezing the name', () => {
    expect(() => renderServiceWorker("const VERSION = 'v2';", 'abc')).toThrow(
      /__TANGRAM_BUILD_ID__/,
    );
  });

  it('refuses a build id that would not survive being quoted', () => {
    for (const bad of ["a'; caches.delete('x", 'two words', 'line\nbreak', '']) {
      expect(() => normalizeBuildId(bad)).toThrow(/build id/);
    }
    expect(normalizeBuildId(' Xy_-09 \n')).toBe('Xy_-09');
  });

  it('falls back to the dev stamp when no build has run', () => {
    // `pnpm dev` never registers a worker, so a missing .next is not an error.
    expect(readBuildId('/nonexistent/.next/BUILD_ID')).toBe(DEV_BUILD_ID);
  });

  it('keeps the network-first navigation and the offline page it was given', () => {
    // The worker's behaviour is the template's; this pins that the generator is
    // not where a policy change could sneak in.
    const worker = renderServiceWorker(template, 'abc123');
    expect(worker).toContain("const OFFLINE_URL = '/offline.html'");
    const body = worker.slice(worker.indexOf('async function shell('), worker.indexOf("addEventListener('fetch"));
    expect(body.indexOf('await fetch(request)')).toBeLessThan(body.indexOf('cache.match(request'));
  });
});
