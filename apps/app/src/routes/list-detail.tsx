import { useParams } from 'react-router';

import { ListDetail } from '@/components/lists/list-detail';

import { RouteMarker } from './route-marker';

/**
 * One list's words, inside the Library tab (docs/plans/core.md C7).
 *
 * **The heading is `ListDetail`'s, not this route's.** It is the list's name,
 * and the name lives in IndexedDB — the component that reads the list is the
 * one that knows it, and knows when it has arrived. It used to be a generic
 * "Library" here, which made every list announce as the same word.
 */
export function ListDetailRoute() {
  const { id } = useParams<{ id: string }>();
  return (
    <div data-testid="screen-list-detail">
      <RouteMarker path="/library/lists/:id" />
      {id ? <ListDetail listId={id} /> : null}
    </div>
  );
}
