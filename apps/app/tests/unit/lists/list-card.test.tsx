/**
 * "Mark all known" has two disabled states and they mean opposite things
 * (HANDOFF.md, "The one flaky spec").
 *
 * `busy` is a write in flight — wait, and it will finish. `all-known` is
 * nothing left to do, and it arrives *without anyone pressing anything*: a band
 * at or below `settings.knownBand` counts as known the moment its membership is
 * materialised, so the button disables itself behind the background fill. A
 * caller that can only see `disabled` cannot tell "in a moment" from "never",
 * which is what left an e2e clicking a button for thirty seconds. The state is
 * on the element so it does not have to be guessed from the label.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ListCard } from '@/components/lists/list-card';
import type { ListRow } from '@/lib/db/schema';
import type { ListView } from '@/lib/stores/lists';

const noop = () => {};

function view(count: number, knownCount: number): ListView {
  const list: ListRow = {
    id: 'list-1',
    name: 'HSK 1',
    owner: 'system',
    kind: 'hsk',
    band: 1,
    active: true,
    order: 1,
    systemKey: 'hsk:1',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  };
  return { list, count, knownCount };
}

function button() {
  return screen.getByRole('button', { name: 'Mark all known: HSK 1' });
}

describe('the mark-all-known button', () => {
  it('is pressable when there is something left to mark', () => {
    render(<ListCard view={view(500, 12)} onToggleActive={noop} onMarkAllKnown={noop} />);
    expect(button()).toHaveAttribute('data-mark-state', 'idle');
    expect(button()).toBeEnabled();
    expect(button()).toHaveTextContent('Mark all known');
  });

  it('says a write is in flight rather than only going grey', () => {
    render(<ListCard view={view(500, 12)} busy onToggleActive={noop} onMarkAllKnown={noop} />);
    expect(button()).toHaveAttribute('data-mark-state', 'busy');
    expect(button()).toBeDisabled();
    expect(button()).toHaveTextContent('Marking…');
  });

  it('says the list is spent when every word in it already reads as known', () => {
    render(<ListCard view={view(500, 500)} onToggleActive={noop} onMarkAllKnown={noop} />);
    expect(button()).toHaveAttribute('data-mark-state', 'all-known');
    expect(button()).toBeDisabled();
    expect(button()).toHaveTextContent('All known');
  });

  it('is pressable while the list is still empty — the counts have not arrived', () => {
    // Before the background fill reaches this band there is nothing to compare,
    // and "0 of 0 known" is not "all known".
    render(<ListCard view={view(0, 0)} onToggleActive={noop} onMarkAllKnown={noop} />);
    expect(button()).toHaveAttribute('data-mark-state', 'idle');
    expect(screen.queryByTestId('list-count')).toBeNull();
  });
});
