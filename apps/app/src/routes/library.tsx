import { LibraryScreen } from '@/components/screens/library';

/**
 * `data/ATTRIBUTION.md`, rendered in Library (docs/plans/core.md C7).
 *
 * This used to be a per-request `readFile` of `<dataDir()>/ATTRIBUTION.md` from
 * a `force-dynamic` server component, so that `TANGRAM_DATA_DIR` could relocate
 * it. There is no server here, so it is a **build-time raw import of the
 * committed file** (Vite's `?raw`). That trades away runtime relocation of the
 * attribution text, which is acceptable because the file is committed rather
 * than generated — but it is stated here rather than inferred, because CLAUDE.md
 * makes rendering it a licence obligation, not a nicety. A build now carries the
 * attribution that was committed when it was built, which is the licence-correct
 * pairing anyway: the notice ships with the code it describes.
 *
 * It is read **here**, in the route module, rather than in the screen: `?raw`
 * is a bundler feature, and a screen that reaches for one cannot be rendered by
 * anything but this bundler.
 */
import attribution from '@data/ATTRIBUTION.md?raw';

import { RouteMarker } from './route-marker';

export function LibraryRoute() {
  return (
    <>
      <RouteMarker path="/library" />
      <LibraryScreen attribution={attribution} />
    </>
  );
}
