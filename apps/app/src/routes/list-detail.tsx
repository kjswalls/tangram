import { useParams } from 'react-router';

import { ListDetail } from '@/components/lists/list-detail';
import { PageHeader } from '@/components/ui/page-header';

/**
 * One list's words, inside the Library tab (docs/plans/core.md C7).
 *
 * The name lives in IndexedDB, so the heading stays generic and the card inside
 * carries the real title.
 */
export function ListDetailRoute() {
  const { id } = useParams<{ id: string }>();
  return (
    <div data-testid="screen-list-detail">
      <PageHeader title="Library">Every word in this list, and what state it is in.</PageHeader>
      {id ? <ListDetail listId={id} /> : null}
    </div>
  );
}
