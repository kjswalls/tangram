/**
 * Free recall's request goes through `apiFetch` (docs/plans/backend.md B1).
 *
 * **The bug this pins was already shipped and was invisible.**
 * `requestRecallGrade` (`packages/ai/recall.ts`) calls
 * `fetchImpl('/api/recall', …)` with the global `fetch`, so it sent a
 * same-origin request carrying no `X-Tangram-Access`. Against a gated
 * deployment every free-recall grade was a 401, and nobody saw it: the function
 * turns every failure into "no suggestion" and the four grade buttons stay live
 * either way. After B1 it is worse than invisible — the handler is on another
 * origin now, so a relative `/api/recall` reaches a static host that answers 404
 * and the feature is simply dead.
 *
 * `tests/unit/server/routes.test.ts` refuses a literal `/api/…` fetch anywhere
 * in `apps/app`, which is the general rule. This is the specific one: the two
 * places that default a `RecallRequest` — `components/review/recall-input.tsx`
 * and `lib/srs/direction.ts`'s `productionRecallRequest` — must default to the
 * wrapper and not to the bare function. A textual check could not tell those
 * apart; calling it can.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_HEADER } from '@tangram/access';

import { appRecallRequest } from '@/lib/api/recall-client';
import { initAccess, revokeAccess, API_BASE } from '@/src/access/client';

const INPUT = { entryId: '你好|你好[ni3 hao3]', answer: 'hello' };

/** A `fetch` that records the call and answers a valid suggestion. */
function recorder(): { calls: { url: string; headers: Headers }[]; fetch: typeof fetch } {
  const calls: { url: string; headers: Headers }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ suggested: 3, why: 'close enough', provider: 'fake' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { calls, fetch: fetchImpl as unknown as typeof fetch };
}

afterEach(() => {
  revokeAccess();
  vi.unstubAllGlobals();
});

describe('appRecallRequest', () => {
  it('sends the access header once a key has been exchanged', async () => {
    const recorded = recorder();
    // The exchange, through the module's own entry point rather than by poking
    // at storage: what is under test is that the credential `initAccess` stores
    // is the one this request carries.
    const location = { href: 'https://app.example/practice?key=a-valid-key-1234' } as Location;
    vi.stubGlobal('history', { replaceState: () => {} });
    await initAccess(location, async () => 'granted');

    vi.stubGlobal('fetch', recorded.fetch);
    const suggestion = await appRecallRequest(INPUT);

    expect(suggestion?.suggested).toBe(3);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]?.headers.get(ACCESS_HEADER)).toBe('a-valid-key-1234');
  });

  it('applies the API base, so the call does not land on the app’s own origin', async () => {
    const recorded = recorder();
    vi.stubGlobal('fetch', recorded.fetch);
    await appRecallRequest(INPUT);
    // `API_BASE` is '' in the unit environment — `VITE_API_BASE` is substituted
    // at build time and no test build sets one — so this asserts the
    // COMPOSITION rather than a hostname: whatever the base is, the request is
    // built from it. A call that bypassed `apiFetch` would be indistinguishable
    // here when the base is empty, which is why the header assertion above is
    // the load-bearing one and this is the shape check beside it.
    expect(recorded.calls[0]?.url).toBe(`${API_BASE}/api/recall`);
  });

  it('lets a caller override the fetch, which is how the tests and the production direction inject', async () => {
    const mine = recorder();
    const global = recorder();
    vi.stubGlobal('fetch', global.fetch);
    await appRecallRequest(INPUT, { fetchImpl: mine.fetch });
    expect(mine.calls).toHaveLength(1);
    expect(global.calls).toHaveLength(0);
  });

  it('sends nothing at all when there is no key, which is every local run', async () => {
    const recorded = recorder();
    vi.stubGlobal('fetch', recorded.fetch);
    await appRecallRequest(INPUT);
    expect(recorded.calls[0]?.headers.get(ACCESS_HEADER)).toBeNull();
  });
});
