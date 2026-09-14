/**
 * The wiring half of A1's back button (`docs/plans/android.md` A1 criterion 6).
 *
 * `back-navigation.test.ts` holds the policy — the four rules and the four
 * hazards. This file holds the three things only a mounted component can get
 * wrong, none of which the model can see: **whether the native listener is
 * attached at all and torn down once**, **whether the action the model returns
 * is actually executed against the router**, and **whether any of it happens off
 * Android**. Together they are the criterion-6 device pass, minus the device.
 *
 * `@capacitor/app` is faked at the module boundary, which is also how the
 * dynamic import inside the effect is observed at all; the platform is faked by
 * installing a `Capacitor` global of the shape the native bridge injects, so
 * `lib/platform/native.ts` answers for real rather than being mocked out.
 */
/*
 * The unwrapped `render`, deliberately, and this is the one place in the suite
 * that wants it. `tests/unit/render` exists because a component containing a
 * `<Link>` needs *a* router; this file needs a **specific** one — a data-mode
 * `createMemoryRouter` whose history it can drive and read back, because the
 * whole subject is what `navigate(-1)` actually lands on. Wrapping that in the
 * helper's `MemoryRouter` would nest two routers and make the history under test
 * the wrong one.
 */
// eslint-disable-next-line no-restricted-imports -- see above
import { act, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { createMemoryRouter, RouterProvider, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type BackListener = () => void;

const listeners: BackListener[] = [];
const removedAt: number[] = [];
const minimizeApp = vi.fn(() => Promise.resolve());
const exitApp = vi.fn(() => Promise.resolve());

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: (_event: string, callback: BackListener) => {
      const index = listeners.push(callback) - 1;
      return Promise.resolve({
        remove: () => {
          removedAt.push(index);
          return Promise.resolve();
        },
      });
    },
    minimizeApp,
    exitApp,
  },
}));

import { HardwareBackButton } from '@/components/shell/hardware-back-button';
import { registerOverlay, resetOverlays } from '@/lib/shell/back-navigation';

const SEVEN = ['/', '/lookup', '/review', '/read', '/lists', '/stats', '/settings'];

/** Listeners that have not been removed — what the device would actually call. */
function live(): BackListener[] {
  return listeners.filter((_, index) => !removedAt.includes(index));
}

async function pressBack() {
  const callback = live().at(-1);
  expect(callback, 'no live backButton listener').toBeDefined();
  await act(async () => {
    callback!();
  });
}

/**
 * **`writable: true` is load-bearing, and finding out why took a debugger.**
 * Importing `@capacitor/app` pulls `@capacitor/core`, whose last statement is
 * `initCapacitorGlobal(globalThis)` — a plain assignment to `globalThis.Capacitor`,
 * as an import side effect. A property defined without `writable` is read-only,
 * so that assignment throws inside the effect's dynamic import, the `.catch`
 * swallows it, and the listener silently never attaches. The symptom is a
 * StrictMode test that reports zero live listeners and looks like a teardown bug
 * in the component. On a device the bridge installs the global by assignment too,
 * so it is writable there; this is a fidelity problem in the fake, not in the app
 * — but it is exactly the import side effect `lib/platform/native.ts`'s header
 * exists to keep out of the web bundle.
 */
function onAndroid() {
  Object.defineProperty(globalThis, 'Capacitor', {
    configurable: true,
    writable: true,
    value: { getPlatform: () => 'android', isNativePlatform: () => true },
  });
}

function Harness({ tabs }: { tabs?: readonly string[] }) {
  const navigate = useNavigate();
  return (
    <>
      <HardwareBackButton tabs={tabs} />
      <button data-testid="to-review" onClick={() => navigate('/review')} />
      <button data-testid="to-lookup" onClick={() => navigate('/lookup')} />
      <button data-testid="to-lists" onClick={() => navigate('/lists')} />
      <button data-testid="to-detail" onClick={() => navigate('/lists/abc')} />
    </>
  );
}

async function mount({
  strict = false,
  tabs,
  at = '/',
}: { strict?: boolean; tabs?: readonly string[]; at?: string } = {}) {
  const router = createMemoryRouter([{ path: '*', element: <Harness tabs={tabs} /> }], {
    initialEntries: [at],
  });
  const tree = <RouterProvider router={router} />;
  const rendered = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  // Let the dynamic import inside the effect resolve.
  await act(async () => {});
  return { router, ...rendered };
}

/**
 * **`beforeEach`, not `afterEach`, and the difference is the whole file.**
 * Testing Library registers its own `afterEach(cleanup)` in
 * `tests/unit/setup.ts`, which unmounts the previous test's tree — and that
 * unmount calls `remove()`, pushing an index into `removedAt` *after* an
 * `afterEach` of ours would have cleared it. The next test's listener is then
 * born at index 0 with 0 already in the removed list, so `live()` is empty and
 * every press-the-button test fails for a reason that has nothing to do with the
 * component. Resetting on the way in cannot race with a teardown.
 */
beforeEach(() => {
  listeners.length = 0;
  removedAt.length = 0;
  minimizeApp.mockClear();
  exitApp.mockClear();
  resetOverlays();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'Capacitor');
});

describe('the listener', () => {
  it('is attached exactly once on Android, and removed on unmount', async () => {
    onAndroid();
    const { unmount } = await mount();

    expect(live()).toHaveLength(1);

    unmount();
    await act(async () => {});
    expect(live()).toHaveLength(0);
  });

  it('does not accumulate one per navigation', async () => {
    // The effect's dependencies are the model and `navigate`, not the location.
    // If either were unstable this would attach a listener per route change and
    // every back press would fire the handler n times.
    onAndroid();
    const { getByTestId } = await mount();

    await act(async () => getByTestId('to-lookup').click());
    await act(async () => getByTestId('to-review').click());

    expect(live()).toHaveLength(1);
  });

  it('leaves exactly one live listener under StrictMode', async () => {
    // React mounts, unmounts and remounts every effect in development. The
    // cleanup runs before the dynamic import has resolved, which is the case the
    // `cancelled` flag exists for — without it the first mount's listener is
    // never removed and survives forever.
    onAndroid();
    await mount({ strict: true });

    expect(live()).toHaveLength(1);
  });

  it('is never attached off Android', async () => {
    // No Capacitor global at all: the web build must not even reach the import.
    await mount();

    expect(listeners).toHaveLength(0);
  });

  it('is never attached in a browser that has loaded @capacitor/core', async () => {
    // The global exists on the web the moment anything imports the package. A
    // presence test would attach here; `isAndroid()` is what must not.
    Object.defineProperty(globalThis, 'Capacitor', {
      configurable: true,
      writable: true,
      value: { getPlatform: () => 'web', isNativePlatform: () => false },
    });
    await mount();

    expect(listeners).toHaveLength(0);
  });
});

describe('what a press actually does', () => {
  it('backgrounds the app at the root of the first tab, and never exits it', async () => {
    onAndroid();
    await mount({ tabs: SEVEN, at: '/' });

    await pressBack();

    expect(minimizeApp).toHaveBeenCalledOnce();
    // exitApp finishes the activity and throws away the session.
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('pops back to the tab root from a route below it', async () => {
    onAndroid();
    const { getByTestId, router } = await mount({ tabs: SEVEN });

    await act(async () => getByTestId('to-lists').click());
    await act(async () => getByTestId('to-detail').click());
    expect(router.state.location.pathname).toBe('/lists/abc');

    await pressBack();

    expect(router.state.location.pathname).toBe('/lists');
    expect(minimizeApp).not.toHaveBeenCalled();
  });

  it('leaves the tab rather than promising a pop that would land outside it', async () => {
    // `/lists/abc` opened straight from `/`: the tab has a page below it, but the
    // history entry below belongs to another tab. This is the case the model can
    // only get right by knowing what `navigate(-1)` would actually do — and the
    // one a per-tab stack got wrong while every model test stayed green.
    onAndroid();
    const { getByTestId, router } = await mount({ tabs: SEVEN, at: '/' });

    await act(async () => getByTestId('to-detail').click());
    await pressBack();

    expect(router.state.location.pathname).toBe('/');
    expect(minimizeApp).not.toHaveBeenCalled();
  });

  it('walks the tab stack out and then backgrounds', async () => {
    onAndroid();
    const { getByTestId, router } = await mount({ tabs: SEVEN });

    await act(async () => getByTestId('to-lookup').click());
    await act(async () => getByTestId('to-review').click());

    await pressBack();
    expect(router.state.location.pathname).toBe('/lookup');

    await pressBack();
    expect(router.state.location.pathname).toBe('/');

    await pressBack();
    expect(minimizeApp).toHaveBeenCalledOnce();
  });

  it('closes the top overlay and leaves the route alone', async () => {
    onAndroid();
    const { getByTestId, router } = await mount({ tabs: SEVEN });
    await act(async () => getByTestId('to-lists').click());
    await act(async () => getByTestId('to-detail').click());

    const close = vi.fn();
    registerOverlay(close);
    await pressBack();

    expect(close).toHaveBeenCalledOnce();
    expect(router.state.location.pathname).toBe('/lists/abc');
    expect(minimizeApp).not.toHaveBeenCalled();
  });
});

describe('the tab list', () => {
  it('is re-read when the shell changes it', async () => {
    // `core.md` C7 re-baselines seven routes to three. A model pinned at the
    // first render would keep answering against the old list, so back at the
    // root of what is now the first tab would switch tabs instead of
    // backgrounding.
    onAndroid();
    const { getByTestId, rerender } = await mount({ tabs: ['/', '/review'], at: '/' });
    await act(async () => getByTestId('to-review').click());

    // Under the mounted list '/review' is not the first tab, and the entry below
    // is another tab's, so a press is a tab switch rather than a background.
    await pressBack();
    expect(minimizeApp).not.toHaveBeenCalled();

    const router = createMemoryRouter([{ path: '*', element: <Harness tabs={['/review', '/']} /> }], {
      initialEntries: ['/review'],
    });
    rerender(<RouterProvider router={router} />);
    await act(async () => {});

    // '/review' is now the first tab, and the rebuilt model has no history and
    // no other tab to fall back to: rule 4.
    await pressBack();
    expect(minimizeApp).toHaveBeenCalledOnce();
  });
});
