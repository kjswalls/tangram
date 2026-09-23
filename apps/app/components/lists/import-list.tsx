'use client';

import { Link } from 'react-router';
import { useMemo, useRef, useState } from 'react';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { listPath } from '@/components/shell/nav';
import { getRepository } from '@/lib/db/get-db';
import type { ListRow } from '@/lib/db/schema';
import { isDictUnavailable } from '@/lib/dict/unavailable';
import { parseImport, type ImportFormat } from '@/lib/lists/import/parse';
import {
  buildPreview,
  planImport,
  type ImportPreview,
  type Resolver,
  type RowStatus,
} from '@/lib/lists/import/resolve';
import { getImportResolver } from '@/lib/lists/import/resolver';

const FORMAT_LABELS: Record<ImportFormat, string> = {
  plain: 'plain text, one word per line',
  pleco: 'a Pleco flashcard export',
  anki: 'an Anki notes export',
};

/**
 * How many preview rows are drawn at once.
 *
 * Nothing bounds a paste. `RESOLVE_MAX_WORDS` and `RESOLVE_CHUNK` bound what
 * reaches SQLite, but a 5,000-line Pleco export used to render 5,000 `<li>`s,
 * many of them carrying a `<select>` of a dozen `<option>`s — and `planImport`
 * re-ran over all 5,000 on every pick. The page, not the plan: the plan still
 * covers every row, so the counts, the Import button and the write are about
 * the whole paste however few of it is on screen.
 *
 * 50, and "Show more", is what `components/lists/list-detail.tsx` already does
 * with HSK 7–9's 5,622 members. One pattern for "too many rows to draw".
 */
const PREVIEW_PAGE = 50;

const STATUS_LABELS: Record<RowStatus, { label: string; tone: BadgeTone }> = {
  add: { label: 'Ready', tone: 'accent' },
  unmatched: { label: 'Not found', tone: 'warning' },
  present: { label: 'Already in list', tone: 'neutral' },
  duplicate: { label: 'Duplicate', tone: 'neutral' },
};

export interface ImportListProps {
  /** A fixed target — a list's own page. Absent in Library, where the learner picks. */
  target?: ListRow;
  /** The custom lists to offer as targets when there is no fixed one. */
  lists?: ListRow[];
  /** After the write: the list it went into and how many rows it added. */
  onImported?: (list: ListRow, added: number) => void;
  /** The dictionary, injectable so a test needs no database behind it. */
  resolver?: Resolver;
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
 * resolved through `DictStore.resolve` — exact hanzi in either script, else
 * pinyin — and **nothing is written until the preview has been read**: a
 * polyphone gets a reading picker defaulting to its most frequent reading, a
 * row the dictionary does not know says so, and rows the list already has are
 * skipped. One `addListMembers` call at the end; no model is ever involved.
 *
 * **The dictionary's absence is not this component's to announce.** Both
 * surfaces that mount it — Library and a list's own page — already carry the
 * one `<DictNotice>` that names the fact and offers the button (`web.md` W6
 * part 2), and `tests/e2e/d/dict-missing-surface.spec.ts` fails if a tab says
 * it twice or prints the raw `Error.message`. So a resolve that fails because
 * there is no dictionary leaves the paste where it is and says nothing here.
 */
export function ImportList({ target, lists = [], onImported, resolver }: ImportListProps) {
  const [open, setOpen] = useState(target !== undefined);
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
  const [shown, setShown] = useState(PREVIEW_PAGE);

  const chosenExisting =
    target ?? (mode === 'existing' ? customLists.find((list) => list.id === existingId) : undefined);

  const plan = useMemo(
    () => (preview ? planImport(preview, selections, present) : undefined),
    [preview, selections, present],
  );
  const ambiguous = preview?.rows.filter((row) => row.options.length > 1).length ?? 0;

  /**
   * **A preview describes one paste and one target, and it has to keep doing
   * so while it is in flight.**
   *
   * A lookup is not instant — on a cold page it waits for the dictionary to
   * open — and everything that decides what a preview *means* stays editable
   * while it runs: the textarea, the new/existing radios, and the list to add
   * to. Without this counter an answer that started against list A landed
   * against list B, carrying A's membership with it, and every word B already
   * shared with A was marked "Already in list" and left out of the write. The
   * learner was then told "skipped 6 already there" about a list that had none
   * of them. The same shape applied to the textarea: `resetPreview` only fired
   * `if (preview)`, so an edit made during the **first** lookup changed nothing
   * and the stale answer described the old paste.
   *
   * So every lookup takes a token, anything that invalidates a preview bumps
   * it, and an answer that comes back stale is dropped rather than shown. It is
   * a counter rather than an `AbortController` because `Resolver` is a plain
   * function by design (it is what makes the preview testable against a map),
   * and the work being abandoned is one already-issued query.
   */
  const previewRun = useRef(0);

  const resetPreview = () => {
    previewRun.current += 1;
    setPreview(undefined);
    setSelections({});
    setResult(undefined);
    setShown(PREVIEW_PAGE);
    // An Import failure has to clear with the paste that caused it, or a banner
    // about the last attempt sits over a preview that succeeded.
    setError(undefined);
    setBusy(null);
  };

  const runPreview = async () => {
    const token = (previewRun.current += 1);
    const current = () => previewRun.current === token;
    setError(undefined);
    setResult(undefined);
    setBusy('preview');
    try {
      // Inside the `try`: the parsers are pure and linear, but a throw out here
      // would be an unhandled rejection with no banner rather than a message.
      const parsed = parseImport(text);
      if (parsed.rows.length === 0) {
        setError('Nothing to import — paste one word per line.');
        return;
      }
      const [built, members] = await Promise.all([
        buildPreview(parsed, resolver ?? getImportResolver()),
        chosenExisting ? getRepository().listMembers(chosenExisting.id) : Promise.resolve([]),
      ]);
      if (!current()) return;
      setPresent(new Set(members.map((member) => member.entryId)));
      setSelections({});
      setShown(PREVIEW_PAGE);
      setPreview(built);
    } catch (cause) {
      if (!current()) return;
      // The dictionary's absence is said once, by the page. See the header.
      setError(isDictUnavailable(cause) ? undefined : errorText(cause));
    } finally {
      if (current()) setBusy(null);
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
      setError(errorText(cause));
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
        <span className="text-sm text-muted">
          Paste words, a Pleco export or an Anki text export.
        </span>
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
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          // Unconditional. The old `if (preview)` guard did nothing during the
          // first lookup, which is exactly when it was needed.
          resetPreview();
        }}
        className="w-full rounded-lg border border-border bg-surface p-3 font-mono text-sm placeholder:text-muted focus:border-accent focus:outline-none"
      />

      {target ? null : (
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex flex-wrap items-center gap-2 pointer-coarse:min-h-11">
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
              className="h-9 max-w-xs pointer-coarse:h-11"
            />
          </label>
          {customLists.length > 0 ? (
            <label className="flex flex-wrap items-center gap-2 pointer-coarse:min-h-11">
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
                className="h-9 rounded-lg border border-border bg-surface px-2 text-sm pointer-coarse:h-11"
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
        {/*
          `secondary`, not the default `primary`: since C1 the primary variant
          is the screen's single filled vermillion action (§1), and Preview is
          not it — Import, below, is the one that writes.
        */}
        <Button
          variant="secondary"
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
        <p role="status" data-testid="import-error" className="text-sm text-warning">
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
            {preview.rows.slice(0, shown).map((row) => {
              const planned = plan.rows[row.index];
              const selectedKey = selections[row.index] ?? row.defaultKey;
              const option =
                row.options.find((candidate) => candidate.key === selectedKey) ?? row.options[0];
              const status = STATUS_LABELS[planned.status];
              return (
                <li
                  key={row.index}
                  data-testid="import-row"
                  data-status={planned.status}
                  data-word={row.row.word}
                  className="flex flex-wrap items-center justify-between gap-3 py-2"
                >
                  {/* `basis-48`: at a basis of zero the word column shrank
                      beside a reading picker until "line 2" wrapped and the
                      gloss read "(c…" on a phone (first-run audit). With a
                      basis the picker wraps below the word instead. */}
                  <span className="min-w-0 flex-1 basis-48">
                    {/*
                      Plain type, no ruby. The preview's job is to show what the
                      dictionary made of each line so the learner can correct
                      it; the reading is right there in the pinyin beside it and
                      in the picker, and per-character annotation over a
                      300-line list is noise rather than help. `<HanziWord>` is
                      for the surfaces a learner reads (C3's table).
                    */}
                    <span className="hanzi text-lg" lang="zh-Hans">
                      {option?.entry.simp ?? row.row.word}
                    </span>{' '}
                    {option ? (
                      <span className="text-sm text-muted">{option.entry.pinyinMarked}</span>
                    ) : null}
                    <span className="ml-2 text-xs text-muted">line {row.row.line}</span>
                    <span className="block truncate text-sm text-muted">
                      {option
                        ? option.entry.glosses.slice(0, 2).join('; ')
                        : `“${row.row.raw}” matched nothing`}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {row.options.length > 1 ? (
                      <select
                        aria-label={`Reading for ${row.row.word}`}
                        value={option?.key}
                        onChange={(event) =>
                          setSelections((current) => ({
                            ...current,
                            [row.index]: event.target.value,
                          }))
                        }
                        className="h-8 max-w-56 rounded-lg border border-border bg-surface px-2 text-sm pointer-coarse:h-11"
                      >
                        {row.options.map((candidate) => (
                          <option key={candidate.key} value={candidate.key}>
                            {candidate.entry.simp} {candidate.entry.pinyinMarked} —{' '}
                            {candidate.entry.glosses[0]}
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

          {shown < preview.rows.length ? (
            <div>
              <Button
                variant="ghost"
                size="sm"
                data-testid="import-show-more"
                onClick={() => setShown((value) => value + PREVIEW_PAGE)}
              >
                Show more ({preview.rows.length - shown} left)
              </Button>
            </div>
          ) : null}

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
          <Link
            to={listPath(result.list.id)}
            className="text-accent underline underline-offset-2"
          >
            {result.list.name}
          </Link>
          {result.skipped > 0 ? `, skipped ${result.skipped} already there` : ''}
          {result.unmatched > 0 ? `, ${result.unmatched} not in the dictionary` : ''}.
        </p>
      ) : null}
    </div>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
