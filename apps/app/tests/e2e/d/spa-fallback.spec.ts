/**
 * The SPA fallback, and the asset URLs it does not break (docs/plans/web.md W1).
 *
 * A history-routed SPA needs every navigation that is not a real file to return
 * `index.html`. That is a **host** behaviour — W2 writes it into
 * `apps/app/vercel.json` — and the preview server's own default hides it, which
 * is exactly why it is asserted here rather than assumed.
 *
 * The second assertion is the one with teeth. `base: '/'` is not a placeholder:
 * with a relative base Vite emits `./assets/<hash>.js` into index.html, and a
 * hard refresh of `/lists/<id>` returns that same document from the fallback,
 * whose script URL now resolves to `/lists/assets/<hash>.js` — which the
 * fallback answers with index.html again, so the deep route boots to a blank
 * page and every route that is not at the root is broken. Relative base and
 * history routing are mutually exclusive. This test is what would catch someone
 * "fixing" the base to make a subpath deploy work.
 */
import { expect, test } from '@playwright/test';

test.describe('the SPA fallback', () => {
  test('a hard refresh of a deep route renders the app, not a 404', async ({ page }) => {
    const response = await page.goto('/lists/does-not-exist-yet');
    expect(response?.status()).toBe(200);
    // The shell rendered, which means index.html was served AND its script ran.
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Lists' })).toBeVisible();
  });

  test("the deep route's asset URLs resolve from the root, not from its path", async ({ page }) => {
    const bad: string[] = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      // Any asset fetched from under the route's own path is the relative-base
      // failure: it would 200 with index.html and the page would stay blank.
      if (/^\/lists\/.+\/assets\//.test(url.pathname)) bad.push(url.pathname);
    });
    await page.goto('/lists/does-not-exist-yet');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    expect(bad, 'assets must be requested from /assets/, not from under the route').toEqual([]);

    const scripts = await page.locator('script[src]').evaluateAll((els) =>
      els.map((el) => (el as HTMLScriptElement).getAttribute('src') ?? ''),
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) expect(src.startsWith('/'), src).toBe(true);
  });

  test('a real file is still served as itself, not swallowed by the fallback', async ({ page }) => {
    // The fallback must not shadow the manifest, the worker or the offline page.
    for (const [path, type] of [
      ['/manifest.webmanifest', 'application/manifest+json'],
      ['/sw.js', 'text/javascript'],
      ['/offline.html', 'text/html'],
      ['/icon.svg', 'image/svg+xml'],
    ] as const) {
      const response = await page.request.get(path);
      expect(response.status(), path).toBe(200);
      expect(response.headers()['content-type'] ?? '', path).toContain(type);
    }
  });
});
