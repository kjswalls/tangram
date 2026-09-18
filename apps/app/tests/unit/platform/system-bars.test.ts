/**
 * A2's inset and system-bar configuration (`docs/plans/android.md` A2).
 *
 * **Every rule in here fails silently.** A wrong `insetsHandling`, a missing
 * `viewport-fit=cover`, a `Keyboard.resizeOnFullScreen` that nobody meant to
 * add — none of them throws, none of them fails a build, and each shows up only
 * as a layout that is subtly wrong on a phone this repository does not have. A2
 * is device-blocked; this file is the part of it that is not.
 *
 * The behaviour being configured is `@capacitor/android@8.5.2`
 * `capacitor/src/main/java/com/getcapacitor/plugin/SystemBars.java`, read
 * 2026-09-14. The constants quoted below are from that file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const setStyle = vi.fn(() => Promise.resolve());
const setStatusBarStyle = vi.fn(() => Promise.resolve());

/**
 * Both plugins, faked at the module boundary. The real `@capacitor/core`
 * installs the `Capacitor` global as an import side effect and its web
 * `SystemBars` is a stub, so neither the call nor its argument would be
 * observable without this.
 */
vi.mock('@capacitor/core', () => ({
  SystemBars: { setStyle },
  SystemBarsStyle: { Dark: 'DARK', Light: 'LIGHT', Default: 'DEFAULT' },
}));

vi.mock('@capacitor/status-bar', () => ({
  StatusBar: { setStyle: setStatusBarStyle },
  Style: { Dark: 'DARK', Light: 'LIGHT', Default: 'DEFAULT' },
}));

import capacitorConfig from '@/capacitor.config';
import { appRoot } from '@/lib/server/roots';
import { applySystemBarsStyle, barStyleFor } from '@/lib/platform/system-bars';

const APP = appRoot(import.meta.dirname);

const systemBars = (capacitorConfig.plugins?.SystemBars ?? {}) as {
  insetsHandling?: string;
  initialViewportFitValueHint?: string;
  style?: string;
};

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'Capacitor');
  setStyle.mockClear();
  setStatusBarStyle.mockClear();
});

describe('SystemBars owns the insets, and nothing else does', () => {
  it("handles insets, and never 'disable'", () => {
    // 'disable' is the one value that hands the insets back to app code that
    // does not exist. 'native' and 'css' both pad the WebView below Chromium
    // 140 and pass `env()` through above it.
    expect(systemBars.insetsHandling).toBeDefined();
    expect(systemBars.insetsHandling).not.toBe('disable');
    expect(['native', 'css']).toContain(systemBars.insetsHandling);
  });

  it("uses 'css', so both env() and the variables answer", () => {
    // Pinned as a cross-plan contract: `core.md` C1's TabBar and Sheet use
    // `env(safe-area-inset-bottom)`, and a later core phase writing
    // `var(--safe-area-inset-bottom)` must not silently get nothing. Only 'css'
    // injects those variables (SystemBars.java `injectSafeAreaCSS`).
    expect(systemBars.insetsHandling).toBe('css');
  });

  it('does not configure Keyboard.resizeOnFullScreen', () => {
    // SystemBars.warnAboutUnsupportedConfigurationValues():
    //   if (!"disable".equals(insetsHandling) && keyboardResizeOnFullScreen) warn(...)
    // Two things resizing for one keyboard. The warning is in logcat, which is
    // exactly where nobody is looking.
    const keyboard = capacitorConfig.plugins?.Keyboard as { resizeOnFullScreen?: boolean } | undefined;
    expect(keyboard?.resizeOnFullScreen).toBeUndefined();
  });

  it('does not install a second safe-area plugin', () => {
    // @capacitor-community/safe-area does the same job as the built-in plugin
    // and its own README says to set `insetsHandling: 'disable'` before using
    // it. Installing both is two owners of one window.
    const pkg = JSON.parse(readFileSync(resolve(APP, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const name of [
      '@capacitor-community/safe-area',
      '@capawesome/capacitor-android-edge-to-edge-support',
      'capacitor-plugin-safe-area',
      '@aashu-dubey/capacitor-statusbar-safe-area',
    ]) {
      expect(pkg.dependencies?.[name], name).toBeUndefined();
      expect(pkg.devDependencies?.[name], name).toBeUndefined();
    }
  });
});

describe('the viewport-fit hint agrees with the document', () => {
  it("says 'cover', and index.html actually does", () => {
    // The hint only prevents a first-paint jump — the plugin re-probes the live
    // document (`viewportMetaJSFunction`) and corrects itself either way. But a
    // hint that disagrees with the page is a lie that costs the jump it was
    // added to prevent, and if the meta tag were ever dropped the hint would be
    // the last place anyone looked. Both are asserted against each other.
    const html = readFileSync(resolve(APP, 'index.html'), 'utf8');
    const viewport = /<meta\s+name="viewport"\s+content="([^"]*)"/.exec(html);
    expect(viewport, 'no viewport meta in index.html').not.toBeNull();

    const declaresCover = viewport![1].includes('viewport-fit=cover');
    expect(declaresCover, 'index.html no longer declares viewport-fit=cover').toBe(true);
    expect(systemBars.initialViewportFitValueHint).toBe(declaresCover ? 'cover' : 'auto');
  });
});

describe('the manifest does not opt out of edge-to-edge', () => {
  it('has no windowOptOutEdgeToEdgeEnforcement', () => {
    // Deprecated, ignored at targetSdk 36, and it would fight the inset handler
    // on the versions where it is still honoured.
    const manifest = readFileSync(resolve(APP, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    expect(manifest).not.toContain('windowOptOutEdgeToEdgeEnforcement');
  });
});

describe('the system bars start legible against the Inkstone ground', () => {
  it("pins 'LIGHT' rather than following the device", () => {
    // `DEFAULT` means "follow the device's dark mode". Inkstone is the default
    // theme on every device including a dark-preferring one — the ruling relayed
    // to this session and recorded in HANDOFF.md, since wave-zero.md carries no
    // §10c, implemented in core.md C0's tokens.css. So DEFAULT paints white icons
    // over #f8f4ec for anyone whose phone is dark.
    expect(systemBars.style).toBe('LIGHT');
  });

  it('gives @capacitor/status-bar the same value, so the two do not race', () => {
    // StatusBar.load() calls setStyle(config.getStyle()) on every launch and that
    // path is ungated; its config default is DEFAULT. Left unset, two plugins
    // write the same WindowInsetsControllerCompat at launch and the later wins.
    const statusBar = capacitorConfig.plugins?.StatusBar as { style?: string } | undefined;
    expect(statusBar?.style).toBe(systemBars.style);
  });

  it("inverts the vendor's naming exactly once, here", () => {
    // SystemBarsStyle.Light is "dark system bar content on a light background".
    // An app ground of light therefore takes LIGHT, and dark takes DARK. Getting
    // this backwards produces invisible icons and nothing else, on a device.
    expect(barStyleFor('light')).toBe('LIGHT');
    expect(barStyleFor('dark')).toBe('DARK');
  });

  it('is a no-op off Android — it does not even reach the plugin', async () => {
    // Called from `core.md`'s theme switch, which is shared UI with no platform
    // branch of its own. Under vitest there is no Capacitor global, so
    // `isAndroid()` is false. Asserting only that it resolves would pass even if
    // it called through, so the assertion is on the plugin.
    await expect(applySystemBarsStyle('dark')).resolves.toBeUndefined();
    await expect(applySystemBarsStyle('light')).resolves.toBeUndefined();
    expect(setStyle).not.toHaveBeenCalled();
    expect(setStatusBarStyle).not.toHaveBeenCalled();
  });

  it('sets DARK on Android when the app ground is dark, and LIGHT when it is light', async () => {
    Object.defineProperty(globalThis, 'Capacitor', {
      configurable: true,
      writable: true,
      value: { getPlatform: () => 'android', isNativePlatform: () => true },
    });

    await applySystemBarsStyle('dark');
    expect(setStyle).toHaveBeenLastCalledWith({ style: 'DARK' });
    // And the second owner, or a rotation would snap the bars back: StatusBar
    // re-applies its own remembered style on every configuration change.
    expect(setStatusBarStyle).toHaveBeenLastCalledWith({ style: 'DARK' });

    await applySystemBarsStyle('light');
    expect(setStyle).toHaveBeenLastCalledWith({ style: 'LIGHT' });
    expect(setStatusBarStyle).toHaveBeenLastCalledWith({ style: 'LIGHT' });
    // No `bar`, which the plugin reads as both.
    const options = setStyle.mock.calls.map((call) => (call as unknown as [Record<string, unknown>])[0]);
    expect(options).toHaveLength(2);
    expect(options.every((o) => !('bar' in o))).toBe(true);
  });

  it('swallows a plugin that rejects, because a theme switch must not throw', async () => {
    Object.defineProperty(globalThis, 'Capacitor', {
      configurable: true,
      writable: true,
      value: { getPlatform: () => 'android', isNativePlatform: () => true },
    });
    setStyle.mockRejectedValueOnce(new Error('not implemented'));
    setStatusBarStyle.mockRejectedValueOnce(new Error('not implemented'));

    await expect(applySystemBarsStyle('dark')).resolves.toBeUndefined();
  });
});
