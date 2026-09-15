/**
 * The per-route DOM marker (docs/plans/web.md W2).
 *
 * **Why a marker at all.** Under the SPA fallback every navigation that is not
 * a real file returns 200 with `index.html`, so a status-only check on a page
 * is a test that cannot fail: it passes against a build whose entry chunk 404s
 * and against routes that no longer exist. `tests/e2e/p0/routes.spec.ts` reads
 * the route table out of `src/routes.tsx` and requires each pattern to put its
 * own marker in the DOM, which is an assertion about what *rendered* rather
 * than about what the server said.
 *
 * **The value is the route PATTERN, not the URL.** `/lists/:id` marks itself
 * `/lists/:id` whatever id is in the address bar, so the spec can compare
 * against the table without re-deriving how a parameter was filled in.
 *
 * `hidden` because it is not content: it must cost no layout, and a marker that
 * is visible is a marker somebody will style. `aria-hidden` for the same reason
 * on the accessibility tree.
 *
 * `core.md` C7 collapses the table to three tabs and will move these with the
 * screens; the spec re-derives itself from the table, so nothing here needs a
 * second edit. What C7 does owe is *running* it — see `web.md` §2.
 */
export function RouteMarker({ path }: { path: string }) {
  return <div data-route={path} hidden aria-hidden="true" />;
}
