'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getRepository } from '@/lib/db/get-db';
import type { ListRow } from '@/lib/db/schema';
import { fetchResolve } from '@/lib/dict/client';
import { parseImport, type ImportFormat } from '@/lib/lists/import/parse';
import {
  buildPreview,
  planImport,
  type ImportPreview,
  type RowStatus,
} from '@/lib/lists/import/resolve';

const FORMAT_LABELS: Record<ImportFormat, string> = {
  plain: 'plain text, one word per line',
  pleco: 'a Pleco flashcard export',
  anki: 'an Anki notes export',
};

const STATUS_LABELS: Record<RowStatus, { label: string; tone: BadgeTone }> = {
  add: { label: 'Ready', tone: 'accent' },
  unmatched: { label: 'Not found', tone: 'warning' },
  present: { label: 'Already in list', tone: 'neutral' },
  duplicate: { label: 'Duplicate', tone: 'neutral' },
};

export interface ImportListProps {
  /** A fixed target — a list's own page. Absent on /lists, where the learner picks. */
  target?: ListRow;
  /** The custom lists to offer as targets when there is no fixed one. */
  lists?: ListRow[];
  /** After the write: the list it went into and how many rows it added. */
  onImported?: (list: ListRow, added: number) => void;
}

interface ImportResult {
  list: ListRow;
  added: number;
  skipped: number;
  unmatched: number;
}

/**
 * Paste a list, see what the dictionary makes of it, then write it in one go.
 *
 * Three shapes are accepted (`lib/lists/import/parse.ts`): plain text, Pleco's
 * flashcard text export and Anki's "Notes in plain text" export. Every row is
 * resolved through `/api/dict/resolve` — exact hanzi in either script, else
 * pinyin — and nothing is written until the preview has been read: a polyphone
 * gets a reading picker defaulting to its most frequent reading, a row the
 * dictionary does not know says so, and rows the list already has are skipped.
 * One `addListMembers` call at the end; no model is ever involved.
 */
export function ImportList({ target, lists = [], onImported }: ImportListProps) {
  const [open, setOpen] = useState(target === undefined ? false : true);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const customLists = lists.filter((list) => list.kind === 'custom');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [existingId, setExistingId] = useState<string>('');
  const [preview, setPreview] = useState<ImportPreview>();
  const [selections, setSelections] = useState<Record<number, string>>({});
  const [present, setPresent] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ImportResult>();

  const chosenExisting =
    target ?? (mode === 'existing' ? customLists.find((list) => list.id === existingId) : undefined);

  const plan = useMemo(
    () => (preview ? planImport(preview, selections, present) : undefined),
    [preview, selections, present],
  );
  const ambiguous = preview?.rows.filter((row) => row.options.length > 1).length ?? 0;

  const resetPreview = () => {
    setPreview(undefined);
    setSelections({});
    setResult(undefined);
  };

  const runPreview = async () => {
    setError(undefined);
    setResult(undefined);
    const parsed = parseImport(text);
    if (parsed.rows.length === 0) {
      setError('Nothing to import — paste one word per line.');
      return;
    }
    setBusy('preview');
    try {
      const [built, members] = await Promise.all([
        buildPreview(parsed, async (words) => (await fetchResolve(words)).results),
        chosenExisting ? getRepository().listMembers(chosenExisting.id) : Promise.resolve([]),
      ]);
      setPresent(new Set(members.map((member) => member.entryId)));
      setSelections({});
      setPreview(built);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    if (!plan || plan.entryIds.length === 0) return;
    setBusy('import');
    setError(undefined);
    try {
      const repo = getRepository();
      let list = chosenExisting;
      if (!list) {
        const all = await repo.lists();
        list = await repo.createList({
          name: name.trim() || 'Imported list',
          owner: 'user',
          kind: 'custom',
          active: true,
          order: all.length,
        });
      }
      const rows = await repo.addListMembers(list.id, plan.entryIds);
      setResult({
        list,
        added: rows.length,
        skipped: plan.counts.present + plan.counts.duplicate,
        unmatched: plan.counts.unmatched,
      });
      setPreview(undefined);
      setSelections({});
      setText('');
      onImported?.(list, rows.length);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" data-testid="import-open" onClick={() => setOpen(true)}>
          Import a list
        </Button>
        <span className="text-sm text-muted">Paste words, a Pleco export or an Anki text export.</span>
      </div>
    );
  }

  return (
    <div data-testid="import-list" className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        One word per line — hanzi in either script, or pinyin. A Pleco flashcard export
        (headword, pinyin, definition) and an Anki “Notes in plain text” export (.txt) are
        recognised by their shape; HTML inside Anki fields is ignored. Anki <code>.apkg</code>{' '}
        files are not supported — export the notes as plain text first.
      </p>

      <textarea
        aria-label="Words to import"
        data-testid="import-text"
        placeholder={'你好\n了\n打算'}
        value={text}
        rows={6}
        onChange={(event) => {
          setText(event.target.value);
          if (preview) resetPreview();
        }}
        className="w-full rounded-lg border border-border bg-surface p-3 font-mono text-sm placeholder:text-muted focus:border-accent focus:outline-none"
      />

      {target ? null : (
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex flex-wrap items-center gap-2">
            <input
              type="radio"
              name="import-target"
              checked={mode === 'new'}
              onChange={() => {
                setMode('new');
                resetPreview();
              }}
            />
            <span>Create a new list</span>
            <Input
              aria-label="Imported list name"
              placeholder="Imported list"
              value={name}
              disabled={mode !== 'new'}
              onChange={(event) => setName(event.target.value)}
              className="h-9 max-w-xs"
            />
          </label>
          {customLists.length > 0 ? (
            <label className="flex flex-wrap items-center gap-2">
              <input
                type="radio"
                name="import-target"
                checked={mode === 'existing'}
                onChange={() => {
                  setMode('existing');
                  if (!existingId) setExistingId(customLists[0].id);
                  resetPreview();
                }}
              />
              <span>Add to an existing list</span>
              <select
                aria-label="Add to list"
                value={existingId || customLists[0].id}
                disabled={mode !== 'existing'}
                onChange={(event) => {
                  setExistingId(event.target.value);
                  resetPreview();
                }}
                className="h-9 rounded-lg border border-border bg-surface px-2 text-sm"
              >
                {customLists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="import-preview"
          disabled={busy !== null || !text.trim()}
          onClick={() => void runPreview()}
        >
          {busy === 'preview' ? 'Looking up…' : 'Preview'}
        </Button>
        {target === undefined ? (
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Close
          </Button>
        ) : null}
      </div>

      {error ? (
        <p role="status" className="text-sm text-warning">
          {error}
        </p>
      ) : null}

      {preview && plan ? (
        <div data-testid="import-preview-rows" className="flex flex-col gap-3">
          <p data-testid="import-summary" className="text-sm text-muted">
            Read as {FORMAT_LABELS[preview.format]}: {plan.counts.add} to add
            {ambiguous > 0 ? ` · ${ambiguous} with several readings — check the picks` : ''}
            {plan.counts.unmatched > 0 ? ` · ${plan.counts.unmatched} not in the dictionary` : ''}
            {plan.counts.present > 0 ? ` · ${plan.counts.present} already in the list` : ''}
            {plan.counts.duplicate > 0 ? ` · ${plan.counts.duplicate} repeated` : ''}
            {preview.skipped > 0 ? ` · ${preview.skipped} lines skipped` : ''}
          </p>

          <ul className="flex flex-col divide-y divide-border">
            {preview.rows.map((row) => {
              const planned = plan.rows[row.index];
              const selectedKey = selections[row.index] ?? row.defaultKey;
              const option = row.options.find((candidate) => candidate.key === selectedKey) ?? row.options[0];
              const status = STATUS_LABELS[planned.status];
              return (
                <li
                  key={row.index}
                  data-testid="import-row"
                  data-status={planned.status}
                  data-word={row.row.word}
                  className="flex flex-wrap items-center justify-between gap-3 py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="hanzi text-lg">{option?.entry.simp ?? row.row.word}</span>{' '}
                    {option ? <span className="text-sm text-muted">{option.entry.pinyinMarked}</span> : null}
                    <span className="ml-2 text-xs text-muted">line {row.row.line}</span>
                    <span className="block truncate text-sm text-muted">
                      {option ? option.entry.glosses.slice(0, 2).join('; ') : `“${row.row.raw}” matched nothing`}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {row.options.length > 1 ? (
                      <select
                        aria-label={`Reading for ${row.row.word}`}
                        value={option?.key}
                        onChange={(event) =>
                          setSelections((current) => ({ ...current, [row.index]: event.target.value }))
                        }
                        className="h-8 max-w-56 rounded-lg border border-border bg-surface px-2 text-sm"
                      >
                        {row.options.map((candidate) => (
                          <option key={candidate.key} value={candidate.key}>
                            {candidate.entry.simp} {candidate.entry.pinyinMarked} — {candidate.entry.glosses[0]}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              data-testid="import-submit"
              disabled={busy !== null || plan.entryIds.length === 0}
              onClick={() => void runImport()}
            >
              {busy === 'import'
                ? 'Importing…'
                : `Import ${plan.entryIds.length} ${plan.entryIds.length === 1 ? 'word' : 'words'}${
                    chosenExisting ? ` into ${chosenExisting.name}` : ''
                  }`}
            </Button>
          </div>
        </div>
      ) : null}

      {result ? (
        <p data-testid="import-result" role="status" className="text-sm">
          Added {result.added} {result.added === 1 ? 'word' : 'words'} to{' '}
          <Link href={`/lists/${result.list.id}`} className="text-accent underline underline-offset-2">
            {result.list.name}
          </Link>
          {result.skipped > 0 ? `, skipped ${result.skipped} already there` : ''}
          {result.unmatched > 0 ? `, ${result.unmatched} not in the dictionary` : ''}.
        </p>
      ) : null}
    </div>
  );
}
