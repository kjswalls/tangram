/**
 * The banner's probe is two things at once, and only one of them is visible.
 *
 * Visibly, it decides whether "run pnpm data" is shown: a 503 from the dictionary
 * means `data/` was never generated. Invisibly, it is the **only** thing in the app
 * that starts the dictionary warm-up — `HEAD /api/dict/hsk` schedules
 * `warmDictionary()` through `after()` (app/api/dict/hsk/route.ts), and nothing
 * else calls that route. Switching this fetch to GET, or dropping it because the
 * banner is normally invisible, silently puts ~1.5 s back on the first lookup of
 * every session; measured, with `pnpm test` and `pnpm e2e` still green either way.
 *
 * So the method is asserted here, not just the status handling.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DataBanner } from '@/components/shell/data-banner';

function stubFetch(status: number): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => new Response(null, { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<DataBanner />', () => {
  it('probes the HSK route with HEAD — the request that starts the warm-up', async () => {
    const fetch = stubFetch(200);
    render(<DataBanner />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith('/api/dict/hsk?band=1', { method: 'HEAD' });
  });

  it('says nothing when the dictionary answers', async () => {
    stubFetch(200);
    render(<DataBanner />);
    await waitFor(() => expect(screen.queryByTestId('data-banner')).toBeNull());
  });

  it('shows the fix when the dictionary is missing', async () => {
    stubFetch(503);
    render(<DataBanner />);
    expect(await screen.findByTestId('data-banner')).toHaveTextContent('pnpm data');
  });

  it('stays silent on any other failure, including the route not existing', async () => {
    for (const status of [404, 500]) {
      stubFetch(status);
      const { unmount } = render(<DataBanner />);
      await waitFor(() => expect(screen.queryByTestId('data-banner')).toBeNull());
      unmount();
    }

    // A network error is not a data problem this component can diagnose.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    render(<DataBanner />);
    await waitFor(() => expect(screen.queryByTestId('data-banner')).toBeNull());
  });
});
