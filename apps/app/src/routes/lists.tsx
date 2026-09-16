import { ListsView } from '@/components/lists/lists-view';
import { PageHeader } from '@/components/shell/page-header';

import { RouteMarker } from './route-marker';

export function ListsRoute() {
  return (
    <>
      <RouteMarker path="/lists" />
      <PageHeader title="Lists">The HSK spine, your looked-up words, and lists you make.</PageHeader>
      <ListsView />
    </>
  );
}
