/**
 * Phase 6 — the PWA shell (PLAN.md §3.6).
 *
 * The e2e serves the production build (`pnpm build && pnpm start`), which is the
 * only mode that registers the worker. What can be observed here is that the
 * manifest is served, typed, and linked, and that the worker registers and
 * activates. Install and offline behaviour are unverified in this container
 * (HANDOFF.md, Phase 6).
 */
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
