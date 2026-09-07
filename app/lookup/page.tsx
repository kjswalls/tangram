import { LookupView } from '@/components/lookup/lookup-view';
import { PageHeader } from '@/components/shell/page-header';

export default function LookupPage() {
  return (
    <>
      <PageHeader title="Lookup">
        Hanzi, pinyin or English — one box, no mode picker.
      </PageHeader>
      {/* Phase 4 passes its ask panel as `askSlot`; the dictionary body never waits
          on it (PLAN.md §3.4). */}
      <LookupView />
    </>
  );
}
