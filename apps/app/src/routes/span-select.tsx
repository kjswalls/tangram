import { SpanSelectHarness } from '@/components/gallery/span-select-harness';

/**
 * The drag-select harness at its own URL (docs/plans/core.md C5a).
 *
 * **Standalone: outside `<Root>`.** R2 depends on it — `ios.md` I2 opens this
 * address on a physical device with no sign-in, no dictionary and no app state
 * behind it, and the crash it is looking for happens during touch on the
 * passage. A harness that needs the rest of the app booted is a harness that
 * cannot answer register #1.
 *
 * Kept as its own module, like the gallery's, so `src/routes.tsx` has exactly
 * one binding to drop when the build-mode flag is off and the tree-shaker has
 * exactly one root to follow.
 */
export function SpanSelectRoute() {
  return <SpanSelectHarness />;
}
