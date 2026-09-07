import { LookupView } from '@/components/lookup/lookup-view';
import { PageHeader } from '@/components/shell/page-header';

export default function LookupPage() {
  return (
    <>
      <PageHeader title="Lookup">
        Hanzi, pinyin or English — one box, no mode picker.
      </PageHeader>
      {/* No `askSlot`: the ask panel is `LookupPanel`'s default ask content, and
          the slot is the override hook for a caller that wants something else
          there. Either way the dictionary body never waits on it (§3.4). */}
      <LookupView />
    </>
  );
}
