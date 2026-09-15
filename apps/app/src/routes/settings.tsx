import { Attribution } from '@/app/settings/attribution';
import { SettingsForm } from '@/app/settings/settings-form';
import { PageHeader } from '@/components/shell/page-header';
import { Card } from '@/components/ui/card';

/**
 * `data/ATTRIBUTION.md`, rendered in /settings.
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
 */
import attribution from '@data/ATTRIBUTION.md?raw';

import { RouteMarker } from './route-marker';

export function SettingsRoute() {
  return (
    <>
      <RouteMarker path="/settings" />
      <PageHeader title="Settings">
        New cards per day, the spine band, what counts as known.
      </PageHeader>

      <div className="flex flex-col gap-4">
        <Card title="Study">
          <SettingsForm />
        </Card>

        <Card title="Licenses">
          <Attribution source={attribution} />
        </Card>
      </div>
    </>
  );
}
