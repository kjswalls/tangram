/**
 * The card that puts install, persistence and the backup on screen
 * (docs/plans/web.md W5).
 *
 * The e2e proves the two criteria that need a real browser — the install
 * affordance under an emulated `display-mode`, and what `persisted()` actually
 * returns here. This file covers the branches a browser cannot be talked into:
 * WebKit's instructions, the pessimistic warning, and the three ways a restore
 * can refuse a file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DataSafetyCard } from '@/components/pwa/data-safety';
import { closeDb, getRepository } from '@/lib/db/get-db';
import { serializeSnapshot } from '@/lib/db/export';
import { MAX_SNAPSHOT_BYTES, parseSnapshot } from '@/lib/db/import';
import { detectEngine, resetInstallCapture, startInstallCapture } from '@/src/pwa/install';
import { requestPersistence, resetPersistence } from '@/src/pwa/persist';
import { DASUAN } from '../db/fixtures';
import { act, render, screen, waitFor } from '../render';

const reload = vi.fn();
const objectUrls: Blob[] = [];

beforeEach(() => {
  objectUrls.length = 0;
  reload.mockClear();
  // jsdom implements neither, and both are how a backup reaches a disk.
  URL.createObjectURL = vi.fn((blob: Blob) => {
    objectUrls.push(blob);
    return `blob:${objectUrls.length}`;
  });
  URL.revokeObjectURL = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  });
});

afterEach(async () => {
  resetInstallCapture();
  resetPersistence();
  await closeDb();
  vi.restoreAllMocks();
});

/**
 * Point the store at a window whose user agent and display mode we choose, and
 * keep its listeners so a `beforeinstallprompt` can be delivered.
 */
function asEngine(userAgent: string, displayMode = 'browser') {
  const listeners = new Map<string, Set<EventListener>>();
  const win: Record<string, unknown> = {
    navigator: { userAgent },
    addEventListener(type: string, listener: EventListener) {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    matchMedia: (query: string) => ({
      matches: query.includes(`(display-mode: ${displayMode})`),
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  };
  // Only Chromium has it, and `install.ts` reads `'onbeforeinstallprompt' in
  // window` to decide between a button and instructions — so a WebKit fake that
  // carries the property is a fake that never reaches the branch WebKit takes.
  if (detectEngine(userAgent) === 'chromium') win.onbeforeinstallprompt = null;
  startInstallCapture(win as unknown as Window);
  return {
    dispatch(type: string, event: Partial<Event> = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event as Event);
    },
  };
}

const SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

describe('what the learner is told', () => {
  it('the hidden file input is not a Tab stop; the Restore button is the control', async () => {
    // First-run audit: Tab went "Restore from a backup…" → an invisible
    // sr-only input, which sat under the Download button on screen.
    render(<DataSafetyCard />);
    const input = (await screen.findByTestId('backup-file')) as HTMLInputElement;
    expect(input.tabIndex).toBe(-1);
    expect(screen.getByTestId('backup-restore').tabIndex).toBe(0);
  });

  it('warns a non-installed Safari tab holding cards, in the pessimistic words', async () => {
    await getRepository().addCardFromEntry(DASUAN, undefined, 0, 'test-dict');
    asEngine(SAFARI);
    await requestPersistence({ storage: { persist: async () => false, persisted: async () => false } } as unknown as Navigator);

    render(<DataSafetyCard />);

    const warning = await screen.findByTestId('storage-warning');
    // Register #13 is unrun. The copy must say the cap applies, not hedge.
    expect(warning.textContent).toMatch(/seven days/i);
    expect(warning.textContent).toMatch(/Home Screen or Dock/i);
    expect(screen.getByTestId('install-instructions').textContent).toMatch(/Add to Home Screen/i);
    // No button: Safari has no programmatic install, and a button that does
    // nothing is worse than a sentence that explains.
    expect(screen.queryByTestId('install-button')).toBeNull();
  });

  it('says nothing alarming to a learner with no cards yet', async () => {
    const counted = vi.spyOn(getRepository(), 'cardCountsByState');
    asEngine(SAFARI);
    await requestPersistence({ storage: { persist: async () => false, persisted: async () => false } } as unknown as Navigator);

    render(<DataSafetyCard />);

    // Wait for the count itself, not for `risk` to read 'unknown': the card
    // renders 'unknown' before the count comes back, so a `waitFor` on it passed
    // at first paint whatever the database held — and this test went green over
    // a card an earlier test had left behind. See HANDOFF.md, "Test isolation".
    await waitFor(() => expect(counted).toHaveBeenCalledTimes(1));
    await act(async () => {
      expect((await counted.mock.results[0].value).total).toBe(0);
    });
    expect(screen.getByTestId('data-safety').dataset.risk).toBe('unknown');
    expect(screen.queryByTestId('storage-warning')).toBeNull();
  });

  it('is quiet once the origin is persisted', async () => {
    await getRepository().addCardFromEntry(DASUAN, undefined, 0, 'test-dict');
    asEngine(CHROME);
    await requestPersistence({ storage: { persist: async () => true, persisted: async () => true } } as unknown as Navigator);

    render(<DataSafetyCard />);

    await waitFor(() => expect(screen.getByTestId('data-safety').dataset.risk).toBe('safe'));
    expect(screen.getByTestId('storage-line').textContent).toMatch(/promised to keep/i);
  });

  it('offers no install to an app that is already installed', async () => {
    asEngine(CHROME, 'standalone');
    render(<DataSafetyCard />);
    expect(await screen.findByTestId('install-installed')).toBeInTheDocument();
    expect(screen.queryByTestId('install-affordance')).toBeNull();
  });

  it('publishes what persisted() returned, so the e2e can record it', async () => {
    asEngine(CHROME);
    await requestPersistence({ storage: { persist: async () => false, persisted: async () => false } } as unknown as Navigator);
    render(<DataSafetyCard />);
    const card = await screen.findByTestId('data-safety');
    expect(card.dataset.persistAsked).toBe('true');
    expect(card.dataset.persistValue).toBe('false');
    expect(card.dataset.persistState).toBe('transient');
  });
});

describe('the backup controls', () => {
  it('downloads a file named after today, holding the learner’s rows', async () => {
    const repo = getRepository();
    await repo.addCardFromEntry(DASUAN, undefined, 0, 'test-dict');
    asEngine(CHROME);

    render(<DataSafetyCard />);
    const anchors: HTMLAnchorElement[] = [];
    const created = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const element = created(tag);
      if (tag === 'a') {
        (element as HTMLAnchorElement).click = () => {};
        anchors.push(element as HTMLAnchorElement);
      }
      return element;
    });

    (await screen.findByTestId('backup-download')).click();

    await waitFor(() => expect(anchors).toHaveLength(1));
    expect(anchors[0].download).toMatch(/^tangram-backup-\d{4}-\d{2}-\d{2}\.json$/);

    // The bytes are the real export, not a placeholder: parse them back and
    // compare the rows against what the seam says the database holds.
    const written = parseSnapshot(await objectUrls[0].text());
    const live = await repo.exportAll();
    expect(serializeSnapshot({ ...written, createdAt: live.createdAt })).toBe(
      serializeSnapshot(live),
    );
    expect(written.rows.cards).toHaveLength(1);
  });

  it('says so when the export itself fails, instead of going quiet', async () => {
    const repo = getRepository();
    vi.spyOn(repo, 'exportAll').mockRejectedValue(new Error('QuotaExceededError'));
    asEngine(CHROME);
    render(<DataSafetyCard />);

    (await screen.findByTestId('backup-download')).click();

    // A button that silently does nothing reads as "saved", which is the worst
    // possible outcome for the one control that exists to be trusted.
    expect((await screen.findByTestId('backup-failed')).textContent).toMatch(/could not be made/i);
  });

  it('refuses a file too large to be read, before reading it, and says so in words', async () => {
    const repo = getRepository();
    await repo.addCardFromEntry(DASUAN, undefined, 0, 'test-dict');
    asEngine(CHROME);
    render(<DataSafetyCard />);

    const file = new File(['{}'], 'holiday.mov', { type: 'video/quicktime' });
    // A real file this size would be a real 256 MiB in the test's memory.
    Object.defineProperty(file, 'size', { value: MAX_SNAPSHOT_BYTES + 1 });
    const read = vi.spyOn(file, 'text');
    const input = (await screen.findByTestId('backup-file')) as HTMLInputElement;
    await choose(input, file);

    expect((await screen.findByTestId('restore-failed')).textContent).toMatch(/too large to restore/i);
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByTestId('restore-confirm')).toBeNull();
    expect(await repo.allCards()).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('refuses a file that is not a backup, and does not touch the database', async () => {
    const repo = getRepository();
    await repo.addCardFromEntry(DASUAN, undefined, 0, 'test-dict');
    asEngine(CHROME);
    render(<DataSafetyCard />);

    const input = (await screen.findByTestId('backup-file')) as HTMLInputElement;
    await choose(input, new File(['this is not json'], 'holiday.json', { type: 'application/json' }));

    expect((await screen.findByTestId('restore-failed')).textContent).toMatch(/not readable/i);
    expect(screen.queryByTestId('restore-confirm')).toBeNull();
    expect(await repo.allCards()).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('refuses a backup with a store missing rather than silently emptying it', async () => {
    const repo = getRepository();
    await repo.addCardFromEntry(DASUAN, undefined, 0, 'test-dict');
    const snapshot = await repo.exportAll();
    const rows: Record<string, unknown> = { ...snapshot.rows };
    delete rows.reviews;
    asEngine(CHROME);
    render(<DataSafetyCard />);

    const input = (await screen.findByTestId('backup-file')) as HTMLInputElement;
    await choose(
      input,
      new File([JSON.stringify({ ...snapshot, rows })], 'partial.json', {
        type: 'application/json',
      }),
    );

    expect((await screen.findByTestId('restore-failed')).textContent).toMatch(/incomplete/i);
    expect(await repo.allCards()).toHaveLength(1);
  });

  it('keeps saying something after the install prompt is dismissed', async () => {
    const win = asEngine(CHROME);
    win.dispatch('beforeinstallprompt', {
      preventDefault: () => {},
      prompt: async () => {},
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: 'web' }),
    } as unknown as Event);

    render(<DataSafetyCard />);
    (await screen.findByTestId('install-button')).click();

    // The captured event can be prompted once and is spent whatever the answer
    // is, and Chromium only fires another on a page LOAD — which a router-mode
    // SPA never does. Going blank here means the learner never sees the
    // sentence about installing again, on the one card that exists to tell them.
    expect((await screen.findByTestId('install-dismissed')).textContent).toMatch(
      /browser’s menu/i,
    );
    expect(screen.queryByTestId('install-button')).toBeNull();
  });

  it('blocks a second restore while one is in flight', async () => {
    const repo = getRepository();
    await repo.addCardFromEntry(DASUAN, undefined, 0, 'test-dict');
    const snapshot = await repo.exportAll();
    asEngine(CHROME);
    render(<DataSafetyCard />);

    const input = (await screen.findByTestId('backup-file')) as HTMLInputElement;
    await choose(
      input,
      new File([serializeSnapshot(snapshot)], 'backup.json', { type: 'application/json' }),
    );
    await screen.findByTestId('restore-confirm');

    let release: (() => void) | undefined;
    vi.spyOn(repo, 'importAll').mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    (await screen.findByTestId('restore-replace')).click();

    await screen.findByTestId('restore-working');
    // Starting another one over an open destructive transaction leaves the card
    // describing a database it is no longer writing.
    expect((screen.getByTestId('backup-restore') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('backup-file') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('backup-download') as HTMLButtonElement).disabled).toBe(true);
    release?.();
  });

  it('asks before it replaces anything, and reloads once it has', async () => {
    const repo = getRepository();
    await repo.addCardFromEntry(DASUAN, undefined, 0, 'test-dict');
    const snapshot = await repo.exportAll();
    asEngine(CHROME);
    render(<DataSafetyCard />);

    const input = (await screen.findByTestId('backup-file')) as HTMLInputElement;
    await choose(
      input,
      new File([serializeSnapshot(snapshot)], 'tangram-backup-2026-09-16.json', {
        type: 'application/json',
      }),
    );

    const confirm = await screen.findByTestId('restore-confirm');
    // The counts are the point: "replace everything" is only answerable if the
    // learner can see what everything is about to become.
    // Singular, and the card count is LIVE rows — tombstones stay in the
    // snapshot and out of the sentence the learner approves.
    expect(confirm.textContent).toMatch(/1 word and 0 answers/);
    expect(confirm.textContent).toMatch(/not a merge/i);
    // Nothing has happened yet.
    expect(reload).not.toHaveBeenCalled();

    (await screen.findByTestId('restore-replace')).click();

    // A restore leaves every screen in the app holding rows from a database
    // that no longer exists, so the reload is part of the feature.
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});

/** Put a file on a hidden `<input type=file>` the way a file picker would. */
async function choose(input: HTMLInputElement, file: File): Promise<void> {
  // jsdom has no `DataTransfer`, and `input.files` is read-only without one.
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: Object.assign([file], { item: (index: number) => [file][index] ?? null }),
  });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await Promise.resolve();
}
