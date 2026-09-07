import { ListDetail } from '@/components/lists/list-detail';
import { PageHeader } from '@/components/shell/page-header';

/**
 * One list's words. The name lives in IndexedDB, which the server cannot read,
 * so the heading is generic and the card inside carries the real title.
 */
export default async function ListPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <PageHeader title="Lists">Every word in this list, and what state it is in.</PageHeader>
      <ListDetail listId={id} />
    </>
  );
}
