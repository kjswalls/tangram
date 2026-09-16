/**
 * W6's acceptance criteria 1 and 4, in a browser (docs/plans/web.md W6).
 *
 * The unit suite checks the bytes and the stylesheet. This checks the two things
 * only a real engine can answer: **what the page actually asks for**, and
 * **what it asks for the second time**.
 *
 * Both are invisible failures. A font CDN slipping back in works perfectly on a
 * developer's laptop and is unreachable from Capacitor's `capacitor://localhost`
 * and from an aeroplane; a font that the service worker does not store also
 * works perfectly, on every load, forever, at full price.
 */
import { expect, test } from '@playwright/test';

const FONT = /\.woff2?(\?|$)/;

test.describe('the fonts are self-hosted and cached', () => {
  test('a first load fetches fonts only from this origin, under /assets/', async ({
    page,
    context,
    baseURL,
  }) => {
    /**
     * **Throttled**, as W6's criterion 1 asks. It is not decoration: a font CDN
     * that has crept back in is invisible on a loopback network, where it
     * answers in a millisecond and nothing waits — the failure it causes is a
     * page that hangs on a plane or inside Capacitor's local scheme. A slow
     * link is the condition under which the difference between "same origin"
     * and "somewhere else" is a thing anyone notices.
     */
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (750 * 1024) / 8,
      uploadThroughput: (250 * 1024) / 8,
    });

    const fonts: string[] = [];
    const foreign: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (request.resourceType() === 'font' || FONT.test(url.pathname)) {
        fonts.push(request.url());
        if (url.origin !== new URL(baseURL ?? '').origin) foreign.push(request.url());
      } else if (url.origin !== new URL(baseURL ?? '').origin) {
        // Not a font, but a third origin asked for during a page load is worth
        // naming here too: `web.md` W7 is the phase that adds one deliberately.
        foreign.push(`${request.resourceType()} ${request.url()}`);
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await cdp.detach();

    expect(foreign, 'a third origin was contacted during a first load').toEqual([]);
    expect(fonts.length, 'no font was requested at all — is the stylesheet in the graph?').toBeGreaterThan(0);
    for (const url of fonts) {
      expect(new URL(url).pathname, url).toMatch(/^\/assets\//);
      // Content-hashed, so the worker's cache-first rule is always correct.
      expect(new URL(url).pathname, url).toMatch(/-[A-Za-z0-9_-]{8}\.woff2$/);
    }
  });

  /**
   * The subset has to be the face that actually draws, not merely a file that
   * downloaded. This asks the engine — `document.fonts` — rather than measuring
   * a width: a missing glyph is `.notdef`, the tofu box, which has a non-zero
   * advance, so width proves nothing. See `scripts/font-coverage-check.ts`.
   */
  test('the hanzi and UI faces are loaded and in the cascade', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);

    const loaded = await page.evaluate(() =>
      [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family),
    );
    expect(loaded).toContain('Noto Serif SC');
    expect(loaded).toContain('DM Sans');

    // The wordmark is `.hanzi`, on every screen, and its three characters are
    // pinned into the first slice (`tests/unit/fonts/app-hanzi.test.ts`).
    const wordmark = page.locator('.hanzi').first();
    await expect(wordmark).toBeVisible();
    const family = await wordmark.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family).toContain('Noto Serif SC');
    const drawn = await page.evaluate(() => document.fonts.check('16px "Noto Serif SC"', '七巧板'));
    expect(drawn, 'the wordmark is not drawn from the shipped subset').toBe(true);
  });

  /**
   * **Zero font requests on a second load.** The worker's cache-first rule is a
   * path prefix over `/assets/`, which is exactly why the files go through the
   * module graph rather than `public/fonts/` — a copy there would keep its
   * authored name, match no rule, and be re-fetched every time with nothing
   * failing.
   *
   * "Zero requests" means zero that reach the network. A response the worker
   * serves from its cache still appears as a request to the page, and
   * `fromServiceWorker()` is what tells the two apart.
   */
  test('a second load asks the network for no font at all', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // The worker has to be controlling this origin before the second load, or
    // the assertion is about nothing.
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, {
      timeout: 20_000,
    });

    const second = await context.newPage();
    const fromNetwork: string[] = [];
    const served: string[] = [];
    second.on('response', (response) => {
      if (!FONT.test(new URL(response.url()).pathname)) return;
      if (response.fromServiceWorker()) served.push(response.url());
      else fromNetwork.push(response.url());
    });

    await second.goto('/');
    await second.waitForLoadState('networkidle');
    await second.evaluate(() => document.fonts.ready);

    expect(served.length, 'the worker served no font — nothing was cached').toBeGreaterThan(0);
    expect(fromNetwork, 'a font was re-fetched on the second load').toEqual([]);
    await second.close();
  });
});
