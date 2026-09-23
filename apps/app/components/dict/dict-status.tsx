/**
 * The four states the dictionary can be in, drawn (docs/plans/core.md C1 and
 * C4a; `data.md` D4/D5a/D5b own the state *model*, this plan owns the screens).
 *
 * **This file is C4a's and C1 lands its presentational half.** C1's criterion is
 * that the gallery renders all four states "each with a stable test id, so
 * C4a's and C7's specs can be written against the same ids" — and the only way
 * for the gallery's ids to *be* C4a's ids is for the gallery to render C4a's
 * component. So the component is here, it is pure (status in, markup out), and
 * C4a adds the half that is not: subscribing to `store.status`, retrying, and
 * `dict-gate.tsx`. HANDOFF.md records the split.
 *
 * Why each state looks the way it does:
 *
 * - **`absent`** is an explicit ask, with the size in it. The artifact is ~13.9
 *   MB brotli over 43.1 MB raw (`data.md` D1) and a silent 14 MB download on a
 *   metered connection is a hostile default.
 * - **`preparing`** is a DETERMINATE bar from `received`/`total`. `data.md` D4
 *   emits those two fields "so `core.md` can show a determinate bar", so an
 *   indeterminate spinner here would be a defect rather than a simplification.
 *   It falls back to indeterminate only when the fields are genuinely absent —
 *   a server that sent no `Content-Length` — and says which it is in the DOM.
 * - **`ready`** has no screen. It is the absence of a banner, so this renders
 *   `null`.
 * - **`failed`** has four distinguishable reasons because they need different
 *   words: a truncated download is "try again", a corrupt file is "we will
 *   re-fetch it", no storage is neither, and an import failure is the one that
 *   is worth reporting. Each offers a retry, because a retry is a re-download
 *   of the same content-addressed file.
 *
 * **The app keeps working without a dictionary** (`data.md` D4). Practice,
 * lists and stats are the learner's own data; only lookup and the reader
 * degrade. Nothing here blocks a route.
 *
 * The native first-launch copy is the same two components with different copy
 * (`ios.md` register #18, `android.md` A5), so `source` parameterises them
 * rather than a second pair being written.
 */
import { cn } from '@/lib/cn';
import { useEffect } from 'react';

import type { DictStatus } from '@/lib/dict/store';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/** Where the bytes are coming from — a download, or a bundled app asset. */
export type DictSource = 'download' | 'asset';

export interface DictStatusViewProps {
  status: DictStatus;
  source?: DictSource;
  /** `absent` → start; `failed` → try again. Absent means the affordance is too. */
  onStart?: () => void;
  className?: string;
  /**
   * Whether the failure's own message is drawn under the reason's words.
   * Development only by default: the message is the store's diagnosis —
   * "the dictionary could not be fetched: TypeError: Failed to fetch", "run
   * pnpm data" — and in a production build it reached the learner verbatim, in
   * monospace (first-run audit, HANDOFF.md 2026-09-23). Production logs it to
   * the console instead, where whoever runs the deployment looks.
   */
  showDetail?: boolean;
}

/** The artifact's size, stated once. `data.md` D1 measured both figures. */
const SIZE_COMPRESSED = '14 MB';
const SIZE_ON_DISK = '43 MB';

const FAILURE: Record<
  Extract<DictStatus, { state: 'failed' }>['reason'],
  { title: string; body: string; retry: string }
> = {
  download: {
    title: 'The dictionary did not finish downloading',
    body: 'The connection dropped part way. Nothing is lost — it picks up from the start of the same file.',
    retry: 'Try again',
  },
  /**
   * **Two producers land here, and the copy may assert nothing about either.**
   * `data.md` D4's is a genuine import failure — the bytes arrived and OPFS
   * refused them. `HttpDictStore`'s is a 503 `dict-data-missing`, which means
   * the artifact was never built or served, so nothing downloaded and nothing
   * arrived. The frozen `DictStatus` union has no reason for the second (see
   * HANDOFF.md, "What `HttpDictStore` cannot do"), so this body says only what
   * is true of both and leaves the diagnosis to `dict-failure-detail`, which
   * carries `run pnpm data` for one and the OPFS error for the other.
   */
  import: {
    title: 'The dictionary could not be opened',
    body: 'It is not available for use on this device. One retry is worth trying; if it fails again, carry on without it — lookup and the reader are what wait on the dictionary, not practice, your lists or your progress.',
    retry: 'Try again',
  },
  storage: {
    title: 'There is not enough room for the dictionary',
    body: `It needs about ${SIZE_ON_DISK} on this device. Free some space and try again — or carry on without it: practice, your lists and your progress are your own data and do not need it.`,
    retry: 'Try again',
  },
  corrupt: {
    title: 'The dictionary on this device is damaged',
    body: 'The file does not match what it should be, so it has been discarded rather than used. Fetching it again is the fix.',
    retry: 'Fetch it again',
  },
};

/**
 * The bar is two divs, not `<progress>`, and that is not preference.
 *
 * An unstyled `<progress>` is painted by the UA: Chromium draws pure `green`
 * on neutral grey, Firefox and Safari draw something else, so the **first
 * screen of a first launch** was a saturated non-palette colour that differed
 * per engine on a warm-paper ground. And its indeterminate state is not
 * animated under this app's stylesheet — measured as six byte-identical frames
 * over 1.3 s — so "no `Content-Length`" rendered as a bar stuck at 0%, which is
 * worse than the indeterminate spinner `data.md` D4 was trying to rule out.
 *
 * Owning it costs a dozen lines and buys tokens, a real indeterminate
 * animation, and `motion-reduce` — and the ARIA is the same `progressbar` role
 * the element would have had, with `aria-valuenow` omitted when the value is
 * genuinely unknown, which is how a screen reader says "indeterminate".
 */
function Progress({ received, total }: { received?: number; total?: number }) {
  const determinate = typeof received === 'number' && typeof total === 'number' && total > 0;
  const pct = determinate ? Math.min(100, Math.max(0, Math.round((received / total) * 100))) : undefined;
  return (
    <div data-testid="dict-progress" data-determinate={determinate ? 'true' : 'false'}>
      <div
        data-testid="dict-progress-bar"
        role="progressbar"
        aria-label="Getting the dictionary"
        aria-valuemin={0}
        {...(determinate
          ? { 'aria-valuemax': total, 'aria-valuenow': received, value: received, max: total }
          : {})}
        className="h-2 w-full overflow-hidden rounded-full bg-border"
      >
        <div
          data-testid="dict-progress-fill"
          className={cn(
            'h-full rounded-full bg-lookup',
            // Indeterminate: a third-width sliver that travels, so a stalled
            // bar and a working one are not the same picture.
            !determinate && 'w-1/3 animate-[dict-sweep_1.4s_ease-in-out_infinite] motion-reduce:animate-none motion-reduce:w-1/3',
          )}
          {...(determinate ? { style: { width: `${pct}%` } } : {})}
        />
      </div>
      <p className="mt-1 text-xs text-muted">
        {determinate
          ? `${pct}% — ${formatMb(received ?? 0)} of ${formatMb(total ?? 0)}`
          : 'Getting the dictionary…'}
      </p>
    </div>
  );
}

function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function DictStatusView({
  status,
  source = 'download',
  onStart,
  className,
  showDetail = import.meta.env.DEV,
}: DictStatusViewProps) {
  const detail = status.state === 'failed' ? status.message : '';
  useEffect(() => {
    if (detail && !showDetail) console.warn(`tangram: the dictionary failed — ${detail}`);
  }, [detail, showDetail]);

  // `ready` is the state with no screen.
  if (status.state === 'ready') return null;

  const asset = source === 'asset';

  if (status.state === 'absent') {
    return (
      <Card
        data-testid="dict-status"
        data-state="absent"
        data-source={source}
        className={cn('flex flex-col gap-3', className)}
      >
        <div>
          <p className="font-medium text-ink">
            {asset ? 'Set up the dictionary' : 'Get the dictionary'}
          </p>
          <p className="mt-1 text-sm text-muted">
            {asset
              ? `It is already in the app — it needs to be unpacked once, about ${SIZE_ON_DISK} on this device. Lookup and the reader wait on it; practice and your lists do not.`
              : `About ${SIZE_COMPRESSED} to download and ${SIZE_ON_DISK} on this device, once. Lookup and the reader wait on it; practice and your lists do not.`}
          </p>
        </div>
        {onStart ? (
          <div>
            <Button data-testid="dict-start" onClick={onStart}>
              {asset ? 'Set it up' : 'Get it'}
            </Button>
          </div>
        ) : null}
      </Card>
    );
  }

  if (status.state === 'preparing') {
    return (
      <Card
        data-testid="dict-status"
        data-state="preparing"
        data-source={source}
        className={cn('flex flex-col gap-3', className)}
      >
        <p className="font-medium text-ink">
          {asset ? 'Unpacking the dictionary' : 'Getting the dictionary'}
        </p>
        <Progress {...(status.received === undefined ? {} : { received: status.received })} {...(status.total === undefined ? {} : { total: status.total })} />
        <p className="text-xs text-muted">
          You can carry on — this finishes in the background, and it picks up where it left off if
          you close the app.
        </p>
      </Card>
    );
  }

  const copy = FAILURE[status.reason];
  return (
    <Card
      data-testid="dict-status"
      data-state="failed"
      data-reason={status.reason}
      data-source={source}
      className={cn('flex flex-col gap-3 border-warning', className)}
    >
      <div>
        <p className="font-medium text-ink">{copy.title}</p>
        <p className="mt-1 text-sm text-muted">{copy.body}</p>
        {showDetail && status.message ? (
          <p className="mt-2 font-mono text-xs text-muted" data-testid="dict-failure-detail">
            {status.message}
          </p>
        ) : null}
      </div>
      {onStart ? (
        <div>
          <Button data-testid="dict-retry" variant="secondary" onClick={onStart}>
            {copy.retry}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
