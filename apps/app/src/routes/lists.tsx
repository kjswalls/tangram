import { ListsView } from '@/components/lists/lists-view';
import { PageHeader } from '@/components/shell/page-header';

export function ListsRoute() {
  return (
    <>
      <PageHeader title="Lists">The HSK spine, your looked-up words, and lists you make.</PageHeader>
      <ListsView />
    </>
  );
}
