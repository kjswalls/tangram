/**
 * Registration is production-only (PLAN.md §3.6), and "production-only" has to
 * mean more than "does nothing in dev".
 *
 * Service-worker registrations are per **origin** and outlive the server that
 * installed them, and `pnpm start -p 3000` (the e2e webServer) and `next dev`
 * share port 3000. A production worker installed there keeps answering
 * navigations under `next dev` from its own cache — a dev server serving
 * yesterday's page, which is the exact symptom the gate exists to prevent. So
 * the dev branch has to tear the worker down, not merely decline to add one.
 */
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RegisterServiceWorker } from '@/components/pwa/register-sw';

function installFakes() {
  const unregister = vi.fn(async () => true);
  const register = vi.fn(async () => ({}) as ServiceWorkerRegistration);
  const del = vi.fn(async () => true);
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register,
      getRegistrations: async () => [{ unregister }, { unregister }],
    },
  });
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { keys: async () => ['tangram-v1', 'tangram-v2'], delete: del },
  });
  return { unregister, register, del };
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker');
  Reflect.deleteProperty(globalThis, 'caches');
});

describe('<RegisterServiceWorker /> outside production', () => {
  it('unregisters every worker on this origin and drops its caches', async () => {
    // vitest runs with NODE_ENV=test, which is the branch under test.
    expect(process.env.NODE_ENV).not.toBe('production');
    const { unregister, register, del } = installFakes();

    render(<RegisterServiceWorker />);
    await vi.waitFor(() => {
      expect(unregister).toHaveBeenCalledTimes(2);
      expect(del).toHaveBeenCalledWith('tangram-v1');
      expect(del).toHaveBeenCalledWith('tangram-v2');
    });
    expect(register).not.toHaveBeenCalled();
  });

  it('survives a browser with no serviceWorker and no CacheStorage', () => {
    expect(() => render(<RegisterServiceWorker />)).not.toThrow();
  });
});
