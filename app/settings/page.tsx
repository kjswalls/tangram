import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PageHeader } from '@/components/shell/page-header';
import { Card } from '@/components/ui/card';
import { dataDir } from '@/lib/dict/load';
import { Attribution } from './attribution';

// `data/ATTRIBUTION.md` is committed, not generated, but it is read per request
// rather than baked into the build because `data/` can be relocated with
// TANGRAM_DATA_DIR — the build has no way to know where it will be.
export const dynamic = 'force-dynamic';

async function readAttribution(): Promise<string | null> {
  try {
    return await readFile(path.join(dataDir(), 'ATTRIBUTION.md'), 'utf8');
  } catch {
    return null;
  }
}

export default async function SettingsPage() {
  const attribution = await readAttribution();

  return (
    <>
      <PageHeader title="Settings">
        New cards per day, the spine band, what counts as known. Controls come in Phase 3.
      </PageHeader>

      <div className="flex flex-col gap-4">
        <Card title="Study">
          <p className="text-sm text-muted">Settings controls come in Phase 3.</p>
        </Card>

        <Card title="Licenses">
          {attribution ? (
            <Attribution source={attribution} />
          ) : (
            <p className="text-sm text-muted">
              <code className="font-mono">data/ATTRIBUTION.md</code> is missing. It is committed,
              not generated — restore it with{' '}
              <code className="font-mono">git checkout data/ATTRIBUTION.md</code>.
            </p>
          )}
        </Card>
      </div>
    </>
  );
}
