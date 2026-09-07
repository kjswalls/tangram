import { LookupPanel } from '@/components/lookup/lookup-panel';
import { PageHeader } from '@/components/shell/page-header';

export default function LookupPage() {
  return (
    <>
      <PageHeader title="Lookup">
        Hanzi, pinyin or English — one box, no mode picker. Search comes in Phase 1.
      </PageHeader>
      <LookupPanel query="" />
    </>
  );
}
