import { PageHeader } from '@/components/shell/page-header';
import { Card } from '@/components/ui/card';

export default function ListsPage() {
  return (
    <>
      <PageHeader title="Lists">The HSK spine, your looked-up words, and lists you make.</PageHeader>
      <Card title="Lists">
        <p className="text-sm text-muted">Lists come in Phase 3.</p>
      </Card>
    </>
  );
}
