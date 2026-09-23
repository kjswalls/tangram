/**
 * One list's page is headed with the list's name (the wide-shell phase,
 * criterion 4; `HANDOFF.md`, W8a's "Recorded, not fixed").
 *
 * Every list used to be headed "Library", so moving from one list to another
 * announced the same word twice and named neither. The name is in IndexedDB,
 * so the part worth a test is the window before it arrives — and in particular
 * list A → list B, where the component stays mounted holding A's data until B's
 * read lands. A heading that said "Verbs" at B's URL for that window is what
 * the announcer would have read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EntrySource } from '@/lib/lists/entry-source';

// Custom lists need no dictionary; refusing keeps this file off the 43 MB one.
// `band` is swappable so a case can hold an HSK band's first fill open.
let band: EntrySource['band'] = () => Promise.reject(new Error('run pnpm data'));
const down: EntrySource = {
  band: (...args) => band(...args),
  entries: () => Promise.reject(new Error('run pnpm data')),
  search: () => Promise.reject(new Error('run pnpm data')),
};

vi.mock('@/lib/lists/entry-source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/lists/entry-source')>()),
  getEntrySource: () => down,
}));

const { ListDetail } = await import('@/components/lists/list-detail');
const { closeDb, getDb, getRepository } = await import('@/lib/db/get-db');
const { routeHeading } = await import('@/src/shell/route-announcer');
const { ensureSystemLists, findHskList } = await import('@/lib/lists/system-lists');
const { render, screen, waitFor } = await import('../render');

// `routeHeading()` looks inside `<main>`, as the announcer does; the shell
// supplies one in the app.
afterEach(async () => {
  band = () => Promise.reject(new Error('run pnpm data'));
  vi.restoreAllMocks();
  await getDb().delete();
  await closeDb();
});

describe("a list's heading", () => {
  it('is the list’s own name, with the way back to Library beside it', async () => {
    const list = await getRepository().createList({ name: 'Kitchen words', kind: 'custom' });
    render(<main><ListDetail listId={list.id} /></main>);

    await waitFor(() => expect(routeHeading()?.textContent).toBe('Kitchen words'));
    expect(routeHeading()?.tagName).toBe('H1');
    expect(routeHeading()).not.toHaveAttribute('aria-busy');
    const crumb = screen.getByTestId('list-breadcrumb');
    expect(crumb).toHaveTextContent('Library');
    expect(crumb).toHaveAttribute('href', '/library');
    // Outside the heading, so the name the announcer reads is the list's alone.
    expect(routeHeading()?.contains(crumb)).toBe(false);
  });

  it('is busy, not generic, until the name has been read', () => {
    render(<main><ListDetail listId="not-read-yet" /></main>);
    // Synchronously after the first render: no read can have landed.
    expect(routeHeading()).toHaveAttribute('aria-busy', 'true');
    expect(routeHeading()?.textContent?.trim()).toBe('');
  });

  it('never holds the previous list’s name at the next list’s id', async () => {
    const repo = getRepository();
    const verbs = await repo.createList({ name: 'Verbs', kind: 'custom' });
    const food = await repo.createList({ name: 'Food', kind: 'custom' });
    const { rerender } = render(<main><ListDetail listId={verbs.id} /></main>);
    await waitFor(() => expect(routeHeading()?.textContent).toBe('Verbs'));
    const heading = routeHeading();

    rerender(<main><ListDetail listId={food.id} /></main>);
    // Same element — focus that was put on it stays — but it no longer claims
    // to be "Verbs".
    expect(routeHeading()).toBe(heading);
    expect(routeHeading()?.textContent).not.toContain('Verbs');
    expect(routeHeading()).toHaveAttribute('aria-busy', 'true');

    await waitFor(() => expect(routeHeading()?.textContent).toBe('Food'));
    expect(routeHeading()).not.toHaveAttribute('aria-busy');
  });

  it('says so when the list does not exist, and keeps the way back', async () => {
    render(<main><ListDetail listId="does-not-exist" /></main>);
    await waitFor(() => expect(routeHeading()?.textContent).toBe('List not found'));
    expect(routeHeading()).not.toHaveAttribute('aria-busy');
    expect(screen.getByTestId('list-breadcrumb')).toHaveAttribute('href', '/library');
  });

  /**
   * The name is one read; the page is many. The first open of an HSK band
   * fills its membership from the dictionary, which can take seconds on a
   * cold device — or never finish where the store is unproven — and the
   * heading must not sit blank (and the announcer fall back to "Library")
   * for any of it. Found by the phase's second adversarial review.
   */
  it('arrives before the list’s words do', async () => {
    band = () => new Promise(() => undefined);
    const hsk1 = findHskList(await ensureSystemLists(getRepository()), 1)!;
    render(
      <main>
        <ListDetail listId={hsk1.id} />
      </main>,
    );
    await waitFor(() => expect(routeHeading()?.textContent).toBe(hsk1.name));
    expect(routeHeading()).not.toHaveAttribute('aria-busy');
    expect(screen.getByText('Loading words…')).toBeInTheDocument();
  });

  /**
   * A failure belongs to the list it happened on. Kept as one unkeyed value,
   * list A's failed read un-busied list B's heading at B's first commit, and
   * the announcer spoke "Library" before B's name could arrive. Found by both
   * adversarial reviews.
   */
  it('is still busy for list B after list A’s read failed', async () => {
    const repo = getRepository();
    const food = await repo.createList({ name: 'Food', kind: 'custom' });
    const lists = vi.spyOn(repo, 'lists').mockRejectedValue(new Error('disk on fire'));
    const { rerender } = render(
      <main>
        <ListDetail listId="list-a" />
      </main>,
    );
    await waitFor(() => expect(screen.getByText('disk on fire')).toBeInTheDocument());
    expect(routeHeading()).not.toHaveAttribute('aria-busy');

    // B's reads are held open: this is the instant the announcer would read.
    lists.mockReturnValue(new Promise(() => undefined));
    rerender(
      <main>
        <ListDetail listId={food.id} />
      </main>,
    );
    expect(routeHeading()).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('disk on fire')).toBeNull();
  });
});
