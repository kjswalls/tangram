/**
 * Registration is production-only (PLAN.md §3.6), and "production-only" has to
 * mean more than "does nothing in dev".
 *
 * Service-worker registrations are per **origin** and outlive the server that
 * installed them, and `pnpm preview` (the e2e webServer) and `pnpm dev` share a
 * port. A production worker installed there keeps answering navigations under
 * the dev server from its own cache — a dev server serving yesterday's page,
 * which is the exact symptom the gate exists to prevent. So the dev branch has
 * to tear the worker down, not merely decline to add one.
 *
 * **And it does not register inside a native WebView** (docs/plans/web.md W1,
 * wave-zero.md §10 ruling 12). `shouldRegister` is the whole predicate, exported
 * because the branch has no other observable output; `ios.md` I1 asserts the
 * same thing on a real device.
 */
import { render } from '../render';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RegisterServiceWorker, shouldRegister } from '@/components/pwa/register-sw';

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
    // vitest runs with import.meta.env.PROD false, which is the branch under test.
    expect(import.meta.env.PROD).toBe(false);
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

describe('the native gate', () => {
  const web = {
    isProduction: true,
    protocol: 'https:',
    hostname: 'app.example.com',
    isSecureContext: true,
    isNativePlatform: false,
  };

  it('registers on a production https origin — the deployed web build', () => {
    expect(shouldRegister(web)).toBe(true);
  });

  it('registers on http://localhost, which is a secure context', () => {
    // This is `pnpm preview` and therefore the whole e2e suite. W1 specifies
    // the test as `protocol === 'https:'`, which would hang every spec that
    // waits on navigator.serviceWorker.ready. See the component's header.
    expect(
      shouldRegister({ ...web, protocol: 'http:', hostname: 'localhost', isSecureContext: true }),
    ).toBe(true);
  });

  it('refuses a plain http origin that is NOT a secure context', () => {
    expect(
      shouldRegister({ ...web, protocol: 'http:', hostname: 'example.com', isSecureContext: false }),
    ).toBe(false);
  });

  it("refuses iOS's capacitor:// scheme", () => {
    expect(shouldRegister({ ...web, protocol: 'capacitor:', isSecureContext: true })).toBe(false);
  });

  it('refuses an Android WebView, whose origin is indistinguishable from preview', () => {
    // http://localhost, secure context, everything the web build looks like.
    // Only the bridge tells them apart, which is why the predicate asks it
    // rather than looking at the URL.
    expect(
      shouldRegister({
        isProduction: true,
        protocol: 'http:',
        hostname: 'localhost',
        isSecureContext: true,
        isNativePlatform: true,
      }),
    ).toBe(false);
  });

  it('still registers on the web once @capacitor/core is a dependency', () => {
    // One build for three platforms: importing @capacitor/core assigns the
    // global in the WEB bundle too, so a bare "is there a Capacitor object"
    // test would switch the PWA's worker off the day ios.md I0 lands.
    // isNativePlatform() is false there, and that is the question asked.
    expect(shouldRegister({ ...web, isNativePlatform: false })).toBe(true);
  });

  it('refuses a Tauri shell on every platform it uses', () => {
    // tauri://localhost on macOS, Linux and iOS...
    expect(shouldRegister({ ...web, protocol: 'tauri:' })).toBe(false);
    // ...and http://tauri.localhost on Windows and Android, which is a secure
    // context and carries no bridge, so only the hostname catches it.
    expect(
      shouldRegister({
        ...web,
        protocol: 'http:',
        hostname: 'tauri.localhost',
        isSecureContext: true,
      }),
    ).toBe(false);
  });

  it('refuses a file:// origin', () => {
    expect(shouldRegister({ ...web, protocol: 'file:', isSecureContext: false })).toBe(false);
  });

  it('registers nowhere outside production, secure context or not', () => {
    expect(shouldRegister({ ...web, isProduction: false })).toBe(false);
  });

  it('is what the component actually calls: a production secure origin registers', async () => {
    const { register } = installFakes();
    vi.stubEnv('PROD', true);
    const secure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    try {
      render(<RegisterServiceWorker />);
      await vi.waitFor(() => expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' }));
    } finally {
      vi.unstubAllEnvs();
      if (secure) Object.defineProperty(window, 'isSecureContext', secure);
      else Reflect.deleteProperty(window, 'isSecureContext');
    }
  });

  it('is what the component actually calls: a Capacitor bridge does not', async () => {
    const { register, unregister } = installFakes();
    vi.stubEnv('PROD', true);
    const secure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(window, 'Capacitor', {
      configurable: true,
      value: { isNativePlatform: () => true },
    });
    try {
      render(<RegisterServiceWorker />);
      await new Promise((done) => setTimeout(done, 20));
      expect(register).not.toHaveBeenCalled();
      // Nor does it tear anything down: inside a WebView there is no stale
      // worker to undo and the caches are the app's.
      expect(unregister).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      Reflect.deleteProperty(window, 'Capacitor');
      if (secure) Object.defineProperty(window, 'isSecureContext', secure);
      else Reflect.deleteProperty(window, 'isSecureContext');
    }
  });
});
