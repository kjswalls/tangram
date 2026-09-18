/**
 * Phase 6 — the PWA shell (PLAN.md §3.6).
 *
 * The e2e serves the production build (`pnpm build && pnpm start`), which is the
 * only mode that registers the worker. What can be observed here is that the
 * manifest is served, typed, and linked, and that the worker registers and
 * activates.
 *
 * **`web.md` W5 added the second half of this file** and moved the line about
 * install being unverified: the install *branch* is observable in Chromium
 * (`display-mode` through CDP, a synthesised `beforeinstallprompt`), so it is
 * asserted below. What stays unverified here is a real Chromium installability
 * heuristic, real offline behaviour, and everything about Safari — register #13
 * needs a Mac (HANDOFF.md, Phase 6 and W5).
 */
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

test.describe('pwa', () => {
  test('serves the manifest with the right content type and links it', async ({ page }) => {
    const response = await page.request.get('/manifest.webmanifest');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/manifest+json');

    const manifest = JSON.parse(await response.text());
    expect(manifest.name).toBe('Tangram');
    expect(manifest.start_url).toBe('/');

    await page.goto('/');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toContain('/manifest.webmanifest');

    const icon = await page.request.get(manifest.icons[0].src);
    expect(icon.status()).toBe(200);
  });

  test('serves sw.js uncached and registers it', async ({ page }) => {
    const worker = await page.request.get('/sw.js');
    expect(worker.status()).toBe(200);
    expect(worker.headers()['content-type']).toContain('javascript');
    expect(worker.headers()['cache-control']).toContain('no-cache');

    await page.goto('/');
    const state = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return {
        scope: registration.scope,
        script: registration.active?.scriptURL ?? null,
      };
    });
    expect(state.script).toContain('/sw.js');
    expect(state.scope).toMatch(/\/$/);

    // getRegistration() resolves to the same worker, which is the acceptance line.
    const registered = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return registration?.active?.state ?? null;
    });
    expect(registered).toBe('activated');
  });
});

/**
 * Install, persistence and the backup (docs/plans/web.md W5).
 *
 * Read the first criterion carefully before "fixing" it: it does **not** assert
 * that `navigator.storage.persisted()` is true. Chromium grants persistence on
 * a heuristic — installed, bookmarked, notification-permitted, engaged — and a
 * headless run against `http://localhost` satisfies none of those, so asserting
 * `true` would be asserting a browser policy this container cannot control. W5
 * says to **assert the code path ran and record what came back**, which is what
 * happens below; the value is attached to the test so a later run on a real
 * machine can be compared against it.
 */
test.describe('storage and install', () => {
  test('asks for persistence after a real interaction, and records the answer', async ({
    page,
  }, testInfo) => {
    await page.goto('/library');
    const card = page.getByTestId('data-safety');
    await expect(card).toBeVisible();

    // Before any interaction the app has READ `persisted()` but must not have
    // asked: Chromium answers `persist()` once per page load and a request
    // during first paint turns a silent grant into a silent refusal.
    await expect(card).toHaveAttribute('data-persist-asked', 'false');

    // A real interaction. The listener is capture-phase on the window, so
    // clicking the card's own heading is enough.
    await card.click({ position: { x: 4, y: 4 } });

    await expect(card).toHaveAttribute('data-persist-asked', 'true');
    const state = await card.getAttribute('data-persist-state');
    const value = await card.getAttribute('data-persist-value');
    const readBack = await page.evaluate(() => navigator.storage.persisted());

    // The record W5 asks for. `data-persist-value` is what the app read;
    // `readBack` is the same question asked again from the test, and the two
    // agreeing is what says the app is reporting the browser rather than a
    // hardcoded string.
    testInfo.annotations.push({
      type: 'register #13 (Chromium, headless, http://localhost)',
      description: `persist() → persisted()=${value}; state=${state}; re-read=${readBack}`,
    });
    expect(['persisted', 'transient']).toContain(state);
    expect(String(readBack)).toBe(value);
  });

  /**
   * **W5 says `display-mode: standalone` is emulable in Chromium. In this
   * container it is not, and the alternative had to be measured rather than
   * assumed.** `Emulation.setEmulatedMedia` with
   * `features: [{name: 'display-mode', value: 'standalone'}]` is accepted by
   * the CDP session and changes nothing — `matchMedia('(display-mode:
   * standalone)')` still reports false — and so do `--app=<url>` and
   * `--start-fullscreen` as launch flags. Headless Chromium reports `browser`
   * in every configuration tried. Recorded in `HANDOFF.md`.
   *
   * So the media query is stubbed in an init script, before any app code runs.
   * What that leaves asserted is the app's branch — `isStandalone()`, the
   * store, and the card's decision not to offer an install — which is this
   * phase's code; what it stops asserting is Chromium's own reporting, which is
   * not. It is the same trade the next test already makes for
   * `beforeinstallprompt`, which headless Chromium also never fires.
   */
  test('offers no install affordance to a window that is already standalone', async ({ page }) => {
    await page.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (query: string) => {
        if (!query.includes('display-mode')) return real(query);
        const list = real(query);
        return new Proxy(list, {
          get(target, property) {
            if (property === 'matches') return query.includes('standalone');
            const value = Reflect.get(target, property) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      };
    });

    await page.goto('/library');
    const card = page.getByTestId('data-safety');
    await expect(card).toHaveAttribute('data-standalone', 'true');
    await expect(card).toHaveAttribute('data-install', 'installed');
    await expect(page.getByTestId('install-affordance')).toHaveCount(0);
    await expect(page.getByTestId('install-installed')).toBeVisible();
  });

  test('offers one when a beforeinstallprompt has been captured', async ({ page }) => {
    await page.goto('/library');
    const card = page.getByTestId('data-safety');
    await expect(card).toHaveAttribute('data-standalone', 'false');
    // Nothing to offer yet: Chromium has not said the site is installable.
    await expect(page.getByTestId('install-affordance')).toHaveCount(0);

    // Chromium will not fire this against a headless localhost run, so the
    // event is synthesised. What is being tested is the capture and the branch
    // — `preventDefault` plus the stored event — not Chromium's installability
    // heuristic, which is not this app's code.
    const prevented = await page.evaluate(() => {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      Object.assign(event, {
        prompt: async () => {},
        userChoice: Promise.resolve({ outcome: 'dismissed', platform: 'web' }),
      });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    // If this is false the mini-infobar appears and the app has lost the choice
    // of when to ask.
    expect(prevented).toBe(true);

    await expect(card).toHaveAttribute('data-install', 'prompt');
    await expect(page.getByTestId('install-button')).toBeVisible();
  });
});

test.describe('the local backup, in a browser', () => {
  test('downloads a real snapshot and restores it back', async ({ page }) => {
    await page.goto('/library');
    await expect(page.getByTestId('data-safety')).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('backup-download').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^tangram-backup-\d{4}-\d{2}-\d{2}\.json$/);

    const path = await download.path();
    const text = await readFile(path, 'utf8');
    const snapshot = JSON.parse(text);
    expect(snapshot.format).toBe(1);
    expect(snapshot.dbVersion).toBe(3);
    expect(Object.keys(snapshot.rows).sort()).toEqual([
      'ask_cache',
      'cards',
      'known_words',
      'list_members',
      'lists',
      'reviews',
      'settings',
      'texts',
      'words',
    ]);

    // …and back in through the file picker. The confirmation is not optional:
    // `importAll` is destructive by contract.
    await page.getByTestId('backup-file').setInputFiles({
      name: download.suggestedFilename(),
      mimeType: 'application/json',
      buffer: Buffer.from(text),
    });
    await expect(page.getByTestId('restore-confirm')).toBeVisible();

    // A restore replaces the database every open screen is reading, so the app
    // reloads rather than carrying on over rows that no longer exist.
    const reloaded = page.waitForEvent('load');
    await page.getByTestId('restore-replace').click();
    await reloaded;
    await expect(page.getByTestId('data-safety')).toBeVisible();
    await expect(page.getByTestId('restore-confirm')).toHaveCount(0);
  });

  test('refuses a file that is not a backup, and says so in words', async ({ page }) => {
    await page.goto('/library');
    await page.getByTestId('backup-file').setInputFiles({
      name: 'photo.json',
      mimeType: 'application/json',
      buffer: Buffer.from('not a backup at all'),
    });
    await expect(page.getByTestId('restore-failed')).toContainText(/not readable/i);
    await expect(page.getByTestId('restore-confirm')).toHaveCount(0);
  });
});
