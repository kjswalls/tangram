'use client';

/**
 * **Keeping your words** — install, persistence and the local backup, on one
 * card in Library (docs/plans/web.md W5).
 *
 * W5 says the affordance's *copy* belongs to `core.md`'s component set and the
 * capture, the platform branch and the standalone detection belong to this
 * phase. `core.md` ships no install component (checked: `components/**` has
 * `pwa/register-sw.tsx` and nothing else PWA-shaped), so this file is the
 * smallest thing that can satisfy W5's two e2e criteria — it is built entirely
 * out of C1's primitives and names no colour of its own. Recorded in
 * `HANDOFF.md` so whoever owns the copy can take it.
 *
 * Why the three sit together rather than in three places: they are one
 * sentence. *Install it so the browser keeps it; the browser may still not
 * promise; here is the file that survives either way.* STACK §2.8's framing is
 * the reason the third one exists at all — losing the dictionary is a
 * re-download, losing the flashcards is the actual loss.
 *
 * **Restore reloads the page.** `importAll` replaces the database wholesale, and
 * every screen in the app is holding rows it read before that happened — a
 * review session mid-card is the worst of them, since grading would write a
 * review against a card that no longer exists. There is no subscription model
 * across the seam to invalidate, so the honest move is to reload rather than to
 * leave a stale app running over a new database.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { serializeSnapshot, snapshotFilename, snapshotSummary } from '@/lib/db/export';
import { readSnapshotFile, SnapshotError } from '@/lib/db/import';
import type { Snapshot } from '@/lib/db/repository';
import { getRepository } from '@/lib/db/get-db';
import {
  promptInstall,
  readInstallState,
  subscribeInstall,
  type InstallState,
} from '@/src/pwa/install';
import { announceRestore } from '@/src/pwa/restore';
import {
  readPersistSnapshot,
  storageRisk,
  subscribePersist,
  type PersistSnapshot,
} from '@/src/pwa/persist';

function useInstallState(): InstallState {
  return useSyncExternalStore(subscribeInstall, readInstallState, readInstallState);
}

function usePersistState(): PersistSnapshot {
  return useSyncExternalStore(subscribePersist, readPersistSnapshot, readPersistSnapshot);
}

/** Hand the learner a file. The one place this component touches the DOM API. */
function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Not immediately: Safari has been observed to cancel a download whose object
  // URL is revoked in the same task as the click.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * "1 word", not "1 words". It reads as a bug otherwise, and it is directly
 * above "it cannot be undone" — the one place in the app where the learner is
 * being asked to trust a number. Found by W5's adversarial review.
 */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

type Restore =
  | { step: 'idle' }
  /** Reading the chosen file. Seconds, on a big one — so it says so. */
  | { step: 'reading'; name: string }
  | { step: 'confirm'; snapshot: Snapshot; name: string }
  | { step: 'working' }
  | { step: 'failed'; message: string };

export function DataSafetyCard() {
  const install = useInstallState();
  const persist = usePersistState();
  const [cards, setCards] = useState<number | null>(null);
  const [restore, setRestore] = useState<Restore>({ step: 'idle' });
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  /**
   * The captured `beforeinstallprompt` can be prompted once and is spent
   * whatever the learner answers, so a dismissal takes the affordance — and the
   * sentence explaining why installing matters — off the screen with it.
   * Chromium fires a fresh event on a later page **load**, which in a router-mode
   * SPA that never reloads is never. So the card keeps saying something.
   */
  const [promptSpent, setPromptSpent] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    getRepository()
      .cardCountsByState()
      .then(
        (counts) => {
          if (!cancelled) setCards(counts.total);
        },
        () => undefined,
      );
    return () => {
      cancelled = true;
    };
  }, []);

  // Reading a file and replacing the database are both states in which a
  // second attempt makes the card lie about what the database is doing.
  const busy = restore.step === 'reading' || restore.step === 'working';

  const risk = storageRisk({
    state: persist.state,
    standalone: install.standalone,
    engine: install.engine,
    hasCards: (cards ?? 0) > 0,
  });

  const onDownload = useCallback(async () => {
    setExporting(true);
    setExportFailed(false);
    try {
      const snapshot = await getRepository().exportAll();
      download(snapshotFilename(snapshot), serializeSnapshot(snapshot));
    } catch {
      // A read that fails — a closed database, a device that cannot hold the
      // serialised snapshot in memory — must say so. A button that goes quiet
      // reads as "saved", and the whole point of this control is that the
      // learner can believe it.
      setExportFailed(true);
    } finally {
      setExporting(false);
    }
  }, []);

  const onChoose = useCallback(async (file: File) => {
    setRestore({ step: 'reading', name: file.name });
    try {
      setRestore({ step: 'confirm', snapshot: await readSnapshotFile(file), name: file.name });
    } catch (error) {
      setRestore({
        step: 'failed',
        message:
          error instanceof SnapshotError
            ? error.message
            : 'That file could not be read as a Tangram backup.',
      });
    }
  }, []);

  const onReplace = useCallback(async (snapshot: Snapshot) => {
    setRestore({ step: 'working' });
    try {
      await getRepository().importAll(snapshot);
    } catch (error) {
      setRestore({
        step: 'failed',
        message:
          error instanceof SnapshotError
            ? error.message
            : // `importAll` is one transaction, so a failure part-way leaves the
              // database exactly as it was — say that first, then the two things
              // that actually cause it, because "it failed" alone is not
              // something a learner can act on.
              'Nothing was changed — your words are as they were. The file may not match this version of Tangram, or the device may be out of space.',
      });
      return;
    }
    // See the header: every screen is holding rows from the database that was
    // just replaced. The other tabs get told too.
    announceRestore();
    window.location.reload();
  }, []);

  return (
    <Card
      title="Keeping your words"
      data-testid="data-safety"
      data-install={install.affordance}
      data-engine={install.engine}
      data-standalone={String(install.standalone)}
      data-persist-state={persist.state}
      data-persist-asked={String(persist.asked)}
      data-persist-value={String(persist.persisted)}
      data-risk={risk}
      aside={
        risk === 'at-risk' ? (
          <Badge tone="warning" data-testid="storage-warning-badge">
            At risk
          </Badge>
        ) : null
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <InstallBlock
          affordance={install.affordance}
          engine={install.engine}
          spent={promptSpent}
          onPrompt={async () => {
            const outcome = await promptInstall();
            if (outcome !== 'accepted') setPromptSpent(true);
          }}
        />
        <StorageLine risk={risk} standalone={install.standalone} engine={install.engine} />

        <div className="flex flex-col gap-2">
          <p className="text-muted">
            A backup is one file with every word, list and answer in it. Keep one somewhere that is
            not this device.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => void onDownload()}
              disabled={exporting || busy}
              data-testid="backup-download"
            >
              {exporting ? 'Preparing…' : 'Download a backup'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => fileInput.current?.click()}
              // A second restore started over one that is in flight leaves the
              // card describing a database it is no longer writing.
              disabled={busy}
              data-testid="backup-restore"
            >
              Restore from a backup…
            </Button>
            {/*
              Hidden rather than absent: Playwright sets files on it directly,
              and a bare file input in the middle of a card is the one control
              in the app that cannot be styled to match anything.
            */}
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              disabled={busy}
              data-testid="backup-file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Clearing lets the learner pick the same file twice after a
                // refusal, which `change` would otherwise not fire for.
                event.target.value = '';
                if (file) void onChoose(file);
              }}
            />
          </div>

          {exportFailed ? (
            <p className="text-warning" data-testid="backup-failed">
              The backup could not be made. Nothing was changed — try again, and if it keeps failing
              the device may be out of space.
            </p>
          ) : null}

          {restore.step === 'confirm' ? (
            <div
              className="rounded-[var(--r-sm)] border border-border bg-paper p-3"
              data-testid="restore-confirm"
            >
              <p>
                <strong>{restore.name}</strong> holds{' '}
                {count(snapshotSummary(restore.snapshot).cards, 'word')} and{' '}
                {count(snapshotSummary(restore.snapshot).reviews, 'answer')}.
              </p>
              <p className="mt-1 text-muted">
                Restoring replaces everything on this device with what is in that file. It is not a
                merge, and it cannot be undone.
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="primary"
                  onClick={() => void onReplace(restore.snapshot)}
                  data-testid="restore-replace"
                >
                  Replace everything
                </Button>
                <Button variant="ghost" onClick={() => setRestore({ step: 'idle' })}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          {restore.step === 'reading' ? (
            <p data-testid="restore-reading">Reading {restore.name}…</p>
          ) : null}

          {restore.step === 'working' ? <p data-testid="restore-working">Restoring…</p> : null}

          {restore.step === 'failed' ? (
            <p className="text-warning" data-testid="restore-failed">
              {restore.message}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function InstallBlock({
  affordance,
  engine,
  spent,
  onPrompt,
}: {
  affordance: InstallState['affordance'];
  engine: InstallState['engine'];
  spent: boolean;
  onPrompt: () => Promise<void>;
}) {
  if (affordance === 'installed') {
    return (
      <p className="text-muted" data-testid="install-installed">
        Tangram is installed on this device.
      </p>
    );
  }

  if (affordance === 'prompt') {
    return (
      <div className="flex flex-col gap-2" data-testid="install-affordance">
        <p>
          Install Tangram and the browser stops treating your words as something it can clear to make
          room.
        </p>
        <div>
          <Button onClick={() => void onPrompt()} data-testid="install-button">
            Install Tangram
          </Button>
        </div>
      </div>
    );
  }

  if (affordance === 'instructions') {
    return (
      <div className="flex flex-col gap-1" data-testid="install-affordance">
        <p>Add Tangram to your device and it keeps your words properly.</p>
        <p className="text-muted" data-testid="install-instructions">
          {engine === 'webkit'
            ? 'In Safari: press Share, then “Add to Home Screen” on iPhone or iPad, or “Add to Dock” on a Mac.'
            : 'Use your browser’s menu to install this app.'}
        </p>
      </div>
    );
  }

  if (spent) {
    // The event is gone and the browser will not hand us another inside this
    // document. Say where the install lives instead of going blank.
    return (
      <p className="text-muted" data-testid="install-dismissed">
        You can install Tangram whenever you like, from your browser’s menu.
      </p>
    );
  }

  return null;
}

function StorageLine({
  risk,
  standalone,
  engine,
}: {
  risk: 'safe' | 'unknown' | 'at-risk';
  standalone: boolean;
  engine: InstallState['engine'];
}) {
  if (risk === 'safe') {
    return (
      <p className="text-muted" data-testid="storage-line">
        {standalone
          ? 'Your words are kept on this device.'
          : 'This browser has promised to keep your words on this device.'}
      </p>
    );
  }

  if (risk === 'at-risk') {
    return (
      <p className="text-warning" data-testid="storage-warning">
        {engine === 'webkit'
          ? // Register #13 is unrun and this copy assumes the worst: Safari has
            // not promised to keep anything, and a site you have not opened for
            // seven days can be cleared. `HANDOFF.md` records the check as
            // unrun and `src/pwa/persist.ts` explains why the copy is pessimistic.
            'Safari has not promised to keep your words, and it can clear a site you have not opened for seven days. Add Tangram to your Home Screen or Dock, and download a backup.'
          : 'This browser has not promised to keep your words, and can clear them when the device is short of space. Install Tangram, and download a backup.'}
      </p>
    );
  }

  return (
    <p className="text-muted" data-testid="storage-line">
      This browser has not promised to keep your words. A backup is what makes that safe.
    </p>
  );
}
