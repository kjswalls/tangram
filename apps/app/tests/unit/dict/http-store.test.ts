/**
 * `HttpDictStore.open()`'s mapping from an HTTP failure onto a `DictStatus`
 * reason (docs/plans/core.md C4a).
 *
 * The four reasons exist "because they need different words on screen", and the
 * screen is chosen by this mapping alone. Nothing asserted it: `dict-states.spec.ts`
 * drives the four reasons off literals set on the gallery's fake store, so it
 * proves the four screens and nothing about which one a real failure produces,
 * and `smoke.spec.ts` only asserts that *a* `dict-status` is visible.
 *
 * It matters most for the case CLAUDE.md calls the expected one — a deploy that
 * skipped `pnpm data`, whose routes answer `503 {error:'dict-data-missing'}`.
 * `data.md` D4 will swap the store underneath this bridge, and with no CI this
 * file is the only thing that will notice if the mapping changes with it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpDictStore } from '@/lib/dict/http-store';
import type { DictStatus } from '@/lib/dict/store';

function answer(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openWith(fetchImpl: typeof fetch): Promise<DictStatus> {
  vi.stubGlobal('fetch', fetchImpl);
  const store = new HttpDictStore();
  await store.open();
  return store.status;
}

describe('HttpDictStore.open()', () => {
  it('reports a built dictionary as ready, stamped with the version it answered with', async () => {
    const status = await openWith(
      answer(200, { meta: { version: '1.3.20251213' }, entries: [] }),
    );
    expect(status).toEqual({ state: 'ready', version: '1.3.20251213' });
  });

  /**
   * **The case a deployment actually lands in.** `dict-data-missing` means the
   * artifact was never built or served — so nothing downloaded and nothing
   * arrived, and the copy for this reason may not say either (see
   * `dict-status.test.tsx`). The frozen `DictStatus` union has no reason of its
   * own for it; folding it into `import` is the bridge's choice and HANDOFF.md
   * records it as a frozen-surface gap rather than a change.
   */
  it('maps a 503 dict-data-missing onto failed{import}, carrying the real diagnosis', async () => {
    const status = await openWith(
      answer(503, { error: 'dict-data-missing', hint: 'run pnpm data' }),
    );
    expect(status).toEqual({ state: 'failed', reason: 'import', message: 'run pnpm data' });
  });

  it('maps any other refusal onto failed{download}', async () => {
    const status = await openWith(answer(500, { error: 'boom', hint: 'the route threw' }));
    expect(status).toEqual({ state: 'failed', reason: 'download', message: 'the route threw' });
  });

  it('maps a dead connection onto failed{download} rather than throwing at the caller', async () => {
    const dead = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const status = await openWith(dead);
    expect(status).toMatchObject({ state: 'failed', reason: 'download' });
  });

  /**
   * `open()` is called on every mount of every dictionary surface, which is what
   * the interface invites. N mounts must make one probe.
   */
  it('is idempotent: concurrent opens share one probe, and a ready store does not re-probe', async () => {
    const fetchImpl = answer(200, { meta: { version: '1' }, entries: [] });
    vi.stubGlobal('fetch', fetchImpl);
    const store = new HttpDictStore();
    await Promise.all([store.open(), store.open(), store.open()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await store.open();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes through preparing before it settles, so a gate can draw the wait', async () => {
    vi.stubGlobal('fetch', answer(200, { meta: { version: '1' }, entries: [] }));
    const store = new HttpDictStore();
    const seen: DictStatus['state'][] = [];
    store.subscribe((status) => seen.push(status.state));
    await store.open();
    expect(seen).toEqual(['preparing', 'ready']);
  });
});
