'use client';

/**
 * The paste box and the shelf of saved texts (PLAN.md §3.5).
 *
 * Saving is not optional on the way in: the store keeps the text across a
 * navigation, but the store is memory and a reload is not. One button does both
 * — `repo.saveText` then segment — so there is no state in which a learner has
 * pasted a page, read half of it, and lost it to a refresh.
 */

import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useReaderStore } from '@/lib/stores/reader';

/** Enough to be worth reading; short enough that a stray keystroke is not one. */
const MIN_CHARS = 1;

export function TextComposer() {
  const body = useReaderStore((state) => state.body);
  const title = useReaderStore((state) => state.title);
  const saved = useReaderStore((state) => state.saved);
  const loading = useReaderStore((state) => state.loading);
  const saving = useReaderStore((state) => state.saving);
  const error = useReaderStore((state) => state.error);
  const setText = useReaderStore((state) => state.setText);
  const setTitle = useReaderStore((state) => state.setTitle);
  const loadSaved = useReaderStore((state) => state.loadSaved);
  const save = useReaderStore((state) => state.save);
  const read = useReaderStore((state) => state.read);
  const open = useReaderStore((state) => state.open);
  const tokens = useReaderStore((state) => state.tokens);
  const setView = useReaderStore((state) => state.setView);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  const busy = loading || saving;

  return (
    <div className="flex flex-col gap-4">
      <Card title="Paste something to read">
        <div className="flex flex-col gap-3">
          <label htmlFor="reader-title" className="sr-only">
            Title
          </label>
          <Input
            id="reader-title"
            data-testid="reader-title"
            value={title}
            placeholder="Title (optional)"
            onChange={(event) => setTitle(event.target.value)}
          />
          <label htmlFor="reader-body" className="sr-only">
            Text
          </label>
          <textarea
            id="reader-body"
            data-testid="reader-input"
            value={body}
            onChange={(event) => setText(event.target.value)}
            rows={8}
            spellCheck={false}
            placeholder="我每天早上七点起床，先喝一杯水，然后去公园跑步。"
            className="hanzi min-h-40 w-full rounded-lg border border-border bg-surface p-3 text-lg leading-relaxed placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              data-testid="read-text"
              disabled={body.trim().length < MIN_CHARS || busy}
              onClick={async () => {
                // Only read on a save that worked. `read()` clears `error` and
                // switches view, which threw away the message and unmounted the
                // only box that shows it — a failed save looked like a
                // successful one until the refresh that lost the text.
                if (await save()) await read();
              }}
            >
              {busy ? 'Reading…' : 'Save and read'}
            </Button>
            {tokens.length > 0 ? (
              <Button data-testid="back-to-text" variant="secondary" onClick={() => setView('read')}>
                Back to the reading view
              </Button>
            ) : null}
            <span className="text-sm text-muted">
              {error ?? 'Tap any word while you read; what you add keeps its sentence.'}
            </span>
          </div>
        </div>
      </Card>

      <Card title="Saved texts" aside={<span className="text-xs text-muted">{saved.length}</span>}>
        {saved.length === 0 ? (
          <p className="text-sm text-muted">Nothing saved yet. The text you read is kept here.</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="saved-texts">
            {saved.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  data-testid="saved-text"
                  data-text-id={row.id}
                  onClick={() => void open(row)}
                  className="w-full rounded-lg border border-border px-3 py-2 text-left transition hover:border-accent"
                >
                  <span className="hanzi block text-base">{row.title}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {row.body.length} characters
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
