import { DictWasmHarness } from '@/components/gallery/dict-wasm-harness';

/**
 * `/dict-wasm` — the OPFS dictionary harness (docs/plans/data.md D4),
 * **outside `<Root>`**.
 *
 * Standalone for the same reason C5a's `/span-select` is: the criteria are about
 * a cold open of a 43 MB artifact in a page with nothing else running, and the
 * app's own shell already opens a `DictStore` of its own. A harness that needs
 * the rest of the app booted measures the rest of the app.
 *
 * Its own module, like the gallery's and the span-select harness's, so
 * `src/routes.tsx` has exactly one binding to drop when the build-mode flag is
 * off and the tree-shaker has exactly one root to follow.
 */
export function DictWasmRoute() {
  return <DictWasmHarness />;
}
