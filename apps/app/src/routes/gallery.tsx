import { Gallery } from '@/components/gallery/gallery';

/**
 * The gallery's route module (docs/plans/core.md C1).
 *
 * Kept as its own module, separate from `components/gallery/gallery.tsx`, so
 * that `src/routes.tsx` has exactly one binding to drop when the build-time
 * flag is unset and the tree-shaker has exactly one root to follow.
 */
export function GalleryRoute() {
  return <Gallery />;
}
