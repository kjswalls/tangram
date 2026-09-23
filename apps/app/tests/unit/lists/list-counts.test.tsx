/**
 * A band's count that is not known yet is never drawn as zero (first-run
 * audit, HANDOFF.md — "Library briefly says 'HSK 7–9: no words yet'").
 *
 * An HSK band is never empty, so an HSK list with no members is a list the
 * background fill has not reached. It used to be derived as `count: 0` and
 * drawn "no words yet", beside "Filling in the HSK lists…", for the seconds a
 * band took to arrive. These hold the derivation (`lib/stores/lists.ts`), the
 * card's three states, and the read that finished behind a newer one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ListCard } from '@/components/lists/list-card';
import type { ListRow } from '@/lib/db/schema';
import type { Repository } from '@/lib/db/repository';
import type { EntrySource } from '@/lib/lists/entry-source';
import type { HskBand } from '@/lib/types';

import { render, screen } from '../render';
import { entry, fakeEntrySource, freshRepository } from './helpers';

const held = vi.hoisted(() => ({
  repo: undefined as unknown as Repository,
  source: undefined as unknown as EntrySource,
}));

vi.mock('@/lib/db/get-db', () => ({ getRepository: () => held.repo }));
vi.mock('@/lib/lists/entry-source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/lists/entry-source')>()),
  getEntrySource: () => held.source,
}));

const { useListsStore } = await import('@/lib/stores/lists');

/** A promise and the function that settles it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const BANDS = { 1: [entry()], 2: [entry()], 3: [entry()], 4: [entry()], 5: [entry()], 6: [entry()], 7: [entry(), entry()] };
let close: () => void = () => {};

beforeEach(() => {
  const { db, repo } = freshRepository();
  close = () => db.close();
  held.repo = repo;
  held.source = fakeEntrySource(BANDS);
  useListsStore.setState({ lists: [], views: [], loading: false, busy: {}, filling: false, error: undefined });
});

afterEach(() => close());

function view(name: string) {
  return useListsStore.getState().views.find((row) => row.list.name === name);
}

describe('the lists store', () => {
  it('derives an unfilled HSK band as not-known, and an empty own list as a real zero', async () => {
    await useListsStore.getState().load();
    for (const band of [1, 2, 3, 4, 5, 6] as const) expect(view(`HSK ${band}`)?.count).toBeNull();
    expect(view('HSK 7–9')?.count).toBeNull();
    expect(view('Looked up')?.count).toBe(0);

    await useListsStore.getState().fillMembers();
    expect(view('HSK 1')?.count).toBe(1);
    expect(view('HSK 7–9')?.count).toBe(2);
  });

  it('drops a read that finishes behind a newer one, rather than un-filling the last band', async () => {
    const band7 = gate();
    const plain = fakeEntrySource(BANDS);
    held.source = {
      ...plain,
      band: async (band: HskBand, page?: { limit?: number; offset?: number }) => {
        if (band === 7) await band7.wait;
        return plain.band(band, page);
      },
    };
    // A repository that can hold one `listMembers` answer after reading it —
    // the shape of a `load()` that read HSK 7–9 as empty and was slow to land.
    const real = held.repo;
    const hold = { armed: false, release: gate() };
    held.repo = new Proxy(real, {
      get(target, key, receiver) {
        if (key !== 'listMembers') return Reflect.get(target, key, receiver) as unknown;
        return async (id: string) => {
          const rows = await target.listMembers(id);
          const hsk79 = useListsStore.getState().lists.find((row) => row.band === 7);
          if (hold.armed && id === hsk79?.id) {
            hold.armed = false;
            await hold.release.wait;
          }
          return rows;
        };
      },
    });

    await useListsStore.getState().load();
    const filled = useListsStore.getState().fillMembers();
    // Wait until the fill is parked on HSK 7–9's band.
    await vi.waitFor(() => expect(view('HSK 6')?.count).toBe(1));

    hold.armed = true;
    const stale = useListsStore.getState().load(); // reads HSK 7–9 as empty, then waits
    await vi.waitFor(() => expect(hold.armed).toBe(false));

    band7.open();
    await filled;
    expect(view('HSK 7–9')?.count).toBe(2);
    expect(useListsStore.getState().filling).toBe(false);

    hold.release.open();
    await stale;
    // Applied, the stale read would put the band back to "not known" with the
    // fill over and nothing left to correct it.
    expect(view('HSK 7–9')?.count).toBe(2);
  });
});

describe('a list card', () => {
  const list: ListRow = {
    id: 'l',
    name: 'HSK 7–9',
    owner: 'system',
    kind: 'hsk',
    band: 7,
    active: true,
    order: 7,
    systemKey: 'hsk:7',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  };
  const noop = () => {};

  it('says it is counting, not "no words yet", while its band is being filled in', () => {
    render(<ListCard view={{ list, count: null, knownCount: 0 }} filling onToggleActive={noop} onMarkAllKnown={noop} />);
    const counts = screen.getByTestId('list-counts');
    expect(counts).toHaveAttribute('data-count-state', 'counting');
    expect(counts.textContent).not.toMatch(/no words|\b0\b/);
  });

  it('says where the words come from when the fill is not running', () => {
    render(<ListCard view={{ list, count: null, knownCount: 0 }} onToggleActive={noop} onMarkAllKnown={noop} />);
    const counts = screen.getByTestId('list-counts');
    expect(counts).toHaveAttribute('data-count-state', 'unfilled');
    expect(counts.textContent).not.toMatch(/no words|\b0\b/);
  });

  it('keeps "no words yet" for a list that really is empty', () => {
    const own = { ...list, name: 'Kitchen', kind: 'custom' as const, owner: 'user' as const, band: undefined };
    render(<ListCard view={{ list: own, count: 0, knownCount: 0 }} filling onToggleActive={noop} onMarkAllKnown={noop} />);
    expect(screen.getByTestId('list-counts')).toHaveAttribute('data-count-state', 'known');
    expect(screen.getByTestId('list-counts').textContent).toMatch(/no words yet/);
  });
});
