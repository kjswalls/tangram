/**
 * The Phase 0 dictionary routes, exercised by calling the handlers with a Request.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { GET as entriesGet } from '@/app/api/dict/entries/route';
import { GET as hskGet, HEAD as hskHead } from '@/app/api/dict/hsk/route';
import { dictVersion, parseIdList } from '@/lib/dict/index';
import { resetDictCache } from '@/lib/dict/load';
import { WARM_UP_NOT_SCHEDULED } from '@/lib/dict/warm';
import type { DictEntry } from '@/lib/dict/types';
import { requireDictData } from './data-required';

const DASUAN = '打算|打算[da3 suan4]';
const GREEN = '綠|绿[lu:4]';

function entriesRequest(query: string): Request {
  return new Request(`http://localhost/api/dict/entries${query}`);
}

function hskRequest(query: string): Request {
  return new Request(`http://localhost/api/dict/hsk${query}`);
}

describe('parseIdList', () => {
  it('splits on commas outside the pinyin brackets only', () => {
    expect(parseIdList(`${DASUAN},${GREEN}`)).toEqual([DASUAN, GREEN]);
    // A proverb's pinyin contains a comma; splitting inside the brackets would
    // silently turn one id into two that match nothing.
    const proverb = '一不做，二不休|一不做，二不休[yi1 bu4 zuo4 , er4 bu4 xiu1]';
    expect(parseIdList(proverb)).toEqual([proverb]);
    expect(parseIdList(` ${DASUAN} , , `)).toEqual([DASUAN]);
  });
});

describe('GET /api/dict/entries', () => {
  beforeAll(requireDictData);

  it('returns the requested entries in order', async () => {
    const res = entriesGet(
      entriesRequest(`?ids=${encodeURIComponent(GREEN)}&ids=${encodeURIComponent(DASUAN)}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: DictEntry[] };
    expect(body.entries.map((e) => e.id)).toEqual([GREEN, DASUAN]);
    expect(body.entries[1].pinyinMarked).toBe('dǎsuàn');
  });

  it('names the snapshot the entries came from', async () => {
    // A card stamps this onto its snapshot; without it every card the lists
    // layer creates records `dictVersion: 'unknown'` (HANDOFF-p3 Needs 1).
    const res = entriesGet(entriesRequest(`?ids=${encodeURIComponent(DASUAN)}`));
    const body = (await res.json()) as { meta: { version: string } };
    expect(body.meta.version).toBe(dictVersion());
    expect(body.meta.version).not.toBe('');
  });

  it('accepts a comma-separated list and drops unknown ids', async () => {
    const res = entriesGet(entriesRequest(`?ids=${encodeURIComponent(`${DASUAN},nope|nope[x1]`)}`));
    const body = (await res.json()) as { entries: DictEntry[] };
    expect(body.entries.map((e) => e.id)).toEqual([DASUAN]);
  });

  it('rejects an empty or oversized id list', async () => {
    expect(entriesGet(entriesRequest('')).status).toBe(400);
    expect(entriesGet(entriesRequest('?ids=')).status).toBe(400);
    const many = Array.from({ length: 201 }, () => 'ids=x').join('&');
    const res = entriesGet(entriesRequest(`?${many}`));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('too-many-ids');
  });
});

describe('GET /api/dict/hsk', () => {
  beforeAll(requireDictData);

  it('returns a band ordered by frequency', async () => {
    const res = hskGet(hskRequest('?band=1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      band: number;
      entries: DictEntry[];
      meta: { version: string };
    };
    expect(body.band).toBe(1);
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.every((e) => e.hskBand === 1)).toBe(true);
    // Same contract as /api/dict/entries: the rows say which snapshot they are.
    expect(body.meta.version).toBe(dictVersion());
  });

  it('serves band 7 (the list labelled 7-9)', async () => {
    const body = (await hskGet(hskRequest('?band=7')).json()) as { entries: DictEntry[] };
    expect(body.entries.length).toBeGreaterThan(0);
  });

  it('rejects a band outside 1-7', async () => {
    for (const query of ['', '?band=0', '?band=8', '?band=two', '?band=1.5']) {
      const res = hskGet(hskRequest(query));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('bad-band');
    }
  });
});

/**
 * The data banner probes this route with HEAD and reads nothing but the status
 * (`components/shell/data-banner.tsx`). Next used to auto-implement it from GET;
 * it is now explicit, so the two can drift, and these are the ways that shows up.
 */
describe('HEAD /api/dict/hsk', () => {
  beforeAll(requireDictData);

  it('answers 200 with no body, and with the headers GET sends', async () => {
    const res = hskHead(hskRequest('?band=1'));
    expect(res.status).toBe(200);
    // A HEAD response carries no body over the wire, and this one does not build
    // one in the first place: the 160 KB band-1 payload is exactly what the
    // banner probes HEAD to avoid.
    expect(res.body).toBeNull();
    expect(await res.text()).toBe('');
    // No body is not the same as no headers. Next's auto-implemented HEAD ran GET
    // and stripped the body, so it answered with GET's `content-type`; asserting
    // the two agree is what stops the explicit one drifting the way `parseBand()`
    // already stops the statuses drifting.
    expect(res.headers.get('content-type')).toBe(
      hskGet(hskRequest('?band=1')).headers.get('content-type'),
    );
  });

  it('warns rather than going quiet when the warm-up cannot be scheduled', () => {
    // Calling the handler directly is exactly the case `after()` throws on, so
    // this is the one place the fallback path can be observed. In production the
    // same line is the only signal that an instance stopped warming itself.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(hskHead(hskRequest('?band=1')).status).toBe(200);
      expect(warn).toHaveBeenCalledWith(WARM_UP_NOT_SCHEDULED, expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects a bad band with the same status GET gives', async () => {
    for (const query of ['', '?band=0', '?band=99', '?band=two', '?band=1.5']) {
      const head = hskHead(hskRequest(query));
      expect(head.status).toBe(hskGet(hskRequest(query)).status);
      expect(head.status).toBe(400);
      expect(((await head.json()) as { error: string }).error).toBe('bad-band');
    }
  });
});

describe('when data/ has not been built', () => {
  const previous = process.env.TANGRAM_DATA_DIR;

  beforeAll(() => {
    // Same situation as renaming data/: the loader throws, the route answers 503.
    process.env.TANGRAM_DATA_DIR = mkdtempSync(join(tmpdir(), 'tangram-nodata-'));
    resetDictCache();
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.TANGRAM_DATA_DIR;
    else process.env.TANGRAM_DATA_DIR = previous;
    resetDictCache();
  });

  it('answers 503 with the command that fixes it', async () => {
    for (const res of [
      entriesGet(entriesRequest(`?ids=${encodeURIComponent(DASUAN)}`)),
      hskGet(hskRequest('?band=1')),
      // The banner keys the "run pnpm data" message off exactly this status, so
      // the explicit HEAD has to reach the same `dictErrorResponse` GET does.
      hskHead(hskRequest('?band=1')),
    ]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'dict-data-missing', hint: 'run pnpm data' });
    }
  });
});
