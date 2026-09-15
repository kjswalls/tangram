import { useParams } from 'react-router';

import { ListDetail } from '@/components/lists/list-detail';
import { PageHeader } from '@/components/shell/page-header';

import { RouteMarker } from './route-marker';

/**
 * One list's words. The id came from Next's awaited `params`; it is
 * `useParams()` now. The name lives in IndexedDB, so the heading stays generic
 * and the card inside carries the real title.
 */
export function ListDetailRoute() {
  const { id } = useParams<{ id: string }>();
  return (
    <>
      <RouteMarker path="/lists/:id" />
      <PageHeader title="Lists">Every word in this list, and what state it is in.</PageHeader>
      {id ? <ListDetail listId={id} /> : null}
    </>
  );
}
