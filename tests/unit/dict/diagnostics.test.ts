/**
 * The three diagnostic headers, and the promise that every dictionary route sends
 * them.
 *
 * The point of `x-tangram-instance` is that two responses can be compared, so a
 * header that is present on five routes and missing on the sixth is worse than
 * no header at all: `scripts/coldstart-probe.ts` would read the gap as a second
 * process and report the deployment is split when it is not. That is why the
 * last case here walks `app/api/dict/**` from the inventory rather than from a
 * list somebody has to remember to extend.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { GET as decompGet } from '@/app/api/dict/decomp/route';
import { GET as entriesGet } from '@/app/api/dict/entries/route';
import { GET as hskGet, HEAD as hskHead } from '@/app/api/dict/hsk/route';
import { GET as searchGet } from '@/app/api/dict/search/route';
import { POST as segmentPost } from '@/app/api/dict/segment/route';
import {
  DICT_WARM_HEADER,
  INDEX_PARTS_HEADER,
  INSTANCE_HEADER,
  INSTANCE_ID,
  stampDictDiagnostics,
} from '@/lib/dict/diagnostics';
import { buildPartInSlices, builtIndexParts, DICT_INDEX_PARTS, getDictIndex } from '@/lib/dict/index';
import { dictionaryWarm, warmDictionary } from '@/lib/dict/warm';
import { resetDictCache } from '@/lib/dict/load';
import { discoverApiRoutes } from '@/lib/server/route-inventory';
import { requireDictData } from './data-required';

const ROOT = resolve(__dirname, '../../..');
const DASUAN = '打算|打算[da3 suan4]';

/**
 * Every dictionary response this suite makes, as thunks: each response's parts
 * header is a snapshot of the moment *it* was answered, and answering one of
 * these builds parts the next one will report.
 */
const CALLS: { name: string; call: () => Response }[] = [
  {
    name: 'GET /api/dict/entries',
    call: () =>
      entriesGet(new Request(`http://localhost/api/dict/entries?ids=${encodeURIComponent(DASUAN)}`)),
  },
  { name: 'GET /api/dict/hsk', call: () => hskGet(new Request('http://localhost/api/dict/hsk?band=1')) },
  {
    name: 'GET /api/dict/search',
    call: () => searchGet(new Request('http://localhost/api/dict/search?q=dasuan')),
  },
  {
    name: 'GET /api/dict/decomp',
    call: () => decompGet(new Request('http://localhost/api/dict/decomp?chars=%E6%89%93')),
  },
  // A 400: the headers have to survive the paths that never touch the data,
  // because "which process refused me" is the question a 400 raises.
  {
    name: 'GET /api/dict/entries (400)',
    call: () => entriesGet(new Request('http://localhost/api/dict/entries')),
  },
];

describe('the diagnostic headers', () => {
  beforeAll(requireDictData);

  it('are on every dictionary response, naming this process', () => {
    for (const { name, call } of CALLS) {
      const response = call();
      expect(response.headers.get(INSTANCE_HEADER), name).toBe(INSTANCE_ID);
      expect(response.headers.get(INDEX_PARTS_HEADER), name).toBe(builtIndexParts().join(','));
      expect(response.headers.get(DICT_WARM_HEADER), name).toBe(dictionaryWarm() ? 'yes' : 'no');
    }
  });

  it('name a process, not a request — the id is one UUID for the module’s life', () => {
    const first = hskGet(new Request('http://localhost/api/dict/hsk?band=1'));
    const second = hskGet(new Request('http://localhost/api/dict/hsk?band=2'));
    expect(first.headers.get(INSTANCE_HEADER)).toBe(second.headers.get(INSTANCE_HEADER));
    expect(INSTANCE_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('report the warm-up state at response time, not at handler entry', async () => {
    // `entries` cannot be answered without `sorted` and `entries` being built, so
    // a header read before the handler ran would be missing them on a cold cache.
    const response = entriesGet(
      new Request(`http://localhost/api/dict/entries?ids=${encodeURIComponent(DASUAN)}`),
    );
    const parts = (response.headers.get(INDEX_PARTS_HEADER) as string).split(',');
    expect(parts).toContain('sorted');
    expect(parts).toContain('entries');
    // A search then adds its own parts to the *next* response's header.
    searchGet(new Request('http://localhost/api/dict/search?q=dasuan'));
    const after = hskGet(new Request('http://localhost/api/dict/hsk?band=1'));
    expect((after.headers.get(INDEX_PARTS_HEADER) as string).split(',')).toContain('hanzi');
  });

  it('ride on POST and on the bodiless HEAD', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // HEAD is the response the probe reads first, and the one whose parts list
      // says whether the banner's probe did its job.
      const head = hskHead(new Request('http://localhost/api/dict/hsk?band=1'));
      expect(head.status).toBe(200);
      expect(head.body).toBeNull();
      expect(head.headers.get(INSTANCE_HEADER)).toBe(INSTANCE_ID);
      expect(head.headers.get(INDEX_PARTS_HEADER)).toContain('hsk');
    } finally {
      warn.mockRestore();
    }

    const post = await segmentPost(
      new Request('http://localhost/api/dict/segment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我们今天去北京' }),
      }),
    );
    expect(post.status).toBe(200);
    expect(post.headers.get(INSTANCE_HEADER)).toBe(INSTANCE_ID);
  });

  it('carry nothing but the id and the fixed parts vocabulary', () => {
    // The rule this pins is "cheap, and never sensitive": the parts list may only
    // ever be words from `DICT_INDEX_PARTS`, so no query, path or payload can be
    // reflected into a header that ships on every response.
    const response = searchGet(
      new Request(`http://localhost/api/dict/search?q=${encodeURIComponent('secret query')}`),
    );
    const value = response.headers.get(INDEX_PARTS_HEADER) as string;
    expect(value.split(',').filter(Boolean).every((part) => /^[a-z]+$/.test(part))).toBe(true);
    expect(value).not.toContain('secret');
    // The warm flag is a two-word vocabulary, and that is the whole of it.
    expect(response.headers.get(DICT_WARM_HEADER)).toMatch(/^(?:yes|no)$/);
  });
});

describe('when data/ has not been built', () => {
  const previous = process.env.TANGRAM_DATA_DIR;

  beforeAll(() => {
    process.env.TANGRAM_DATA_DIR = mkdtempSync(join(tmpdir(), 'tangram-diag-nodata-'));
    resetDictCache();
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.TANGRAM_DATA_DIR;
    else process.env.TANGRAM_DATA_DIR = previous;
    resetDictCache();
  });

  it('stamps the 503 too, with an empty parts list', () => {
    // This is the most diagnostic response of the lot: "the dictionary is
    // missing" plus "and this process has built nothing", from a phone.
    const response = hskGet(new Request('http://localhost/api/dict/hsk?band=1'));
    expect(response.status).toBe(503);
    expect(response.headers.get(INSTANCE_HEADER)).toBe(INSTANCE_ID);
    expect(response.headers.get(INDEX_PARTS_HEADER)).toBe('');
    // `no` rather than a crash: the flag reads the module cache behind a length
    // check, so it never reaches the dictionary it is reporting missing.
    expect(response.headers.get(DICT_WARM_HEADER)).toBe('no');
  });

  it('never turns a 503 into a 500 by reading the index it is reporting on', () => {
    // `builtIndexParts()` reads the module cache rather than the dictionary, so
    // stamping is safe on exactly the path where the dictionary throws.
    expect(() => stampDictDiagnostics(new Response(null, { status: 503 }))).not.toThrow();
  });
});

describe('every dictionary route', () => {
  it('wraps each of its handlers, so the probe cannot see a phantom instance', () => {
    const dictRoutes = discoverApiRoutes(ROOT).filter((route) =>
      route.path.startsWith('/api/dict/'),
    );
    expect(dictRoutes.length).toBeGreaterThanOrEqual(5);
    for (const route of dictRoutes) {
      const source = readFileSync(route.file, 'utf8');
      for (const method of route.methods) {
        expect(
          source,
          `${method} ${route.path} must be wrapped in withDictDiagnostics (lib/dict/diagnostics.ts)`,
        ).toMatch(new RegExp(`^export const ${method} = withDictDiagnostics\\(`, 'm'));
      }
    }
  });
});

/**
 * The header that exists because the parts list structurally cannot answer the
 * question the probe asks it.
 *
 * `warmDictionary()` builds the six index parts *and* two caches keyed off the
 * index object — search's headword prefix indexes and the segmenter's DAG
 * statistics — so `builtIndexParts()` cannot see them however warm they are. This
 * is the state a warm-up frozen after the parts loop leaves behind (an exhausted
 * `waitUntil` budget, or a regression that drops the two cache passes), and it is
 * the state in which the probe used to print "warm-up: settled".
 */
describe('the warm flag, which the parts list cannot stand in for', () => {
  beforeAll(() => {
    requireDictData();
    // The describe above restores TANGRAM_DATA_DIR and resets the cache, so this
    // starts from a process that has built nothing — which is the only way to
    // reach "all six parts, both caches cold" on purpose.
    resetDictCache();
  });

  it('says no while every index part is built and both caches are cold', async () => {
    getDictIndex();
    // Drained rather than awaited: the point is the finished parts, and this is
    // the same slice-wise builder the warm-up drives.
    for (const part of DICT_INDEX_PARTS) {
      const steps = buildPartInSlices(part);
      while (!steps.next().done) {
        /* every slice, as fast as the loop can turn */
      }
    }
    const stamped = stampDictDiagnostics(new Response(null, { status: 200 }));
    expect(stamped.headers.get(INDEX_PARTS_HEADER)).toBe(DICT_INDEX_PARTS.join(','));
    expect(stamped.headers.get(DICT_WARM_HEADER)).toBe('no');

    await warmDictionary();
    expect(stampDictDiagnostics(new Response(null, { status: 200 })).headers.get(DICT_WARM_HEADER)).toBe(
      'yes',
    );
  });
});
