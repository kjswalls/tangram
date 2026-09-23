/**
 * The result count says nothing until there is a query (first-run audit,
 * HANDOFF.md 2026-09-23): an empty box used to read "No matches" beside a
 * panel reading "Nothing looked up yet", on every first visit.
 */
import { describe, expect, it } from 'vitest';

import { SearchResults } from '@/components/lookup/search-results';
import { render, screen } from '../render';

function renderWith(resultQuery: string, total: number) {
  render(
    <SearchResults
      sections={[]}
      total={total}
      shown={0}
      resultQuery={resultQuery}
      onSelect={() => {}}
      onShowMore={() => {}}
      showingMore={false}
      hasMore={false}
    />,
  );
}

describe('the result count', () => {
  it('is absent before anything has been searched', () => {
    renderWith('', 0);
    expect(screen.queryByTestId('result-count')).toBeNull();
    expect(screen.queryByText('No matches')).toBeNull();
  });

  it('says "No matches" for a query that matched nothing', () => {
    renderWith('xqzvw', 0);
    expect(screen.getByTestId('result-count').textContent).toBe('No matches');
  });
});
