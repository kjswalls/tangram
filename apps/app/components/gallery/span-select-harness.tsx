'use client';

/**
 * The drag-select harness (docs/plans/core.md C5a), **re-pointed at the
 * production hook by C5b**.
 *
 * **The riskiest single piece of UI in the project**, built at C5a as a harness
 * and a set of numbers before any production code existed. Both mobile audits
 * reached the same conclusion independently: the platform's own text selection
 * is unusable on a reader, because it sweeps the `<rt>` pinyin into the
 * selection and the clipboard, its precision degrades from characters to lines
 * as the selection grows, and its handles and callout menu fight the dictionary
 * UI.
 *
 * **It no longer carries its own copy of the interaction, and that is C5b's
 * requirement, not a tidy-up.** C5b: "The gallery harness still runs, now
 * driving `use-span-select.ts` rather than its own copy of the logic… A harness
 * that has drifted from the production hook is worth nothing to `ios.md` on the
 * next device run." So everything below the instrumentation is
 * `components/hanzi/use-span-select.ts` — the same module the reader runs — and
 * what is left here is the harness proper: a standalone route, a readout,
 * a Copy affordance, and the measurements `ios.md` I2 reads on a device.
 *
 * **Still nothing here is production.** The harness lives under
 * `components/gallery/**` behind `src/routes.tsx`'s build-mode guard, and
 * `tests/e2e/core/gallery-excluded.spec.ts` proves a production build carries
 * none of it. The import direction is one-way: the harness imports production
 * modules, never the reverse.
 *
 * **Build it so it can be loaded standalone.** `ios.md` I2 opens one URL on a
 * physical device with no sign-in, no dictionary and no app state behind it,
 * and the crash it is looking for happens during touch on the passage. A
 * harness that needs the rest of the app booted cannot answer register #1.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PASSAGE_RUNS, passageRuns } from '@/components/gallery/passage';
import { HanziText } from '@/components/hanzi/hanzi-text';
import { writeSpan } from '@/components/hanzi/span-clipboard';
import {
  AXIS_THRESHOLD_PX,
  SELECTED_CLASS,
  SPAN_HIGHLIGHT_NAME,
  detectCaretApi,
  highlightsSupported,
  useSpanSelect,
  type CaretApi,
  type SpanSelection,
} from '@/components/hanzi/use-span-select';
import { Button } from '@/components/ui/button';

/** The URL `ios.md` I2 opens on the device. Recorded in HANDOFF.md. */
export const HARNESS_PATH = '/span-select';

/**
 * **The string `gallery-excluded.spec.ts` greps the bundles for, and it is the
 * root element's `data-testid` because a marker has to be *rendered*.**
 *
 * The spec used to key on `HARNESS_PATH`, which nothing in the app reads —
 * `src/routes.tsx` carries its own `'/span-select'` literal. Rolldown dropped
 * the unused export, so the marker tracked the route table rather than this
 * module: a production component importing `SpanSelectHarness` shipped the
 * whole harness, its 500-character passage included, and the spec still passed
 * because the constant it greps for had been shaken out. The gallery's own
 * marker never had that hole, because it is rendered — so this one is too.
 *
 * Do not grep the bare string `span-select`: `app/globals.css`'s
 * `::highlight(span-select)` rule ships in production CSS, and since C5b so
 * does `components/hanzi/use-span-select.ts`.
 */
export const HARNESS_MARKER = 'span-select-harness';

/** Re-exported so the C5a spec and `ios.md` I2 keep one import. */
export { AXIS_THRESHOLD_PX, SELECTED_CLASS, SPAN_HIGHLIGHT_NAME as HIGHLIGHT_NAME };
export type { CaretApi };

export interface SpanSelectHarnessProps {
  /** Characters in the passage. 500 is what C5a measures against. */
  minChars?: number;
}

interface Measurements {
  api: CaretApi;
  /** The passage's length in base characters — what "500-character" means. */
  characters: number;
  highlights: boolean;
  /** `pointermove` handler time, in milliseconds, one sample per move. */
  moves: number[];
  /** Frames longer than 20 ms while a drag was in flight. */
  droppedFrames: number;
  frames: number;
}

declare global {
  interface Window {
    /** The harness's own instrumentation. `ios.md` I2 and the spec read it. */
    __spanSelect?: Measurements & { span: { from: number; to: number } | null; text: string };
  }
}

export function SpanSelectHarness({ minChars = 500 }: SpanSelectHarnessProps) {
  const runs = useMemo(() => passageRuns(minChars), [minChars]);

  const [span, setSpan] = useState<SpanSelection | null>(null);
  const [copied, setCopied] = useState<string>();
  const [characters, setCharacters] = useState(0);

  const moves = useRef<number[]>([]);
  const frames = useRef({ frames: 0, dropped: 0 });
  const spanRef = useRef<SpanSelection | null>(null);

  const report = useCallback((next: SpanSelection | null) => {
    window.__spanSelect = {
      api: detectCaretApi(),
      characters: charactersRef.current(),
      highlights: highlightsSupported(),
      moves: [...moves.current],
      droppedFrames: frames.current.dropped,
      frames: frames.current.frames,
      span: next ? { from: next.from, to: next.to } : null,
      text: next?.text ?? '',
    };
  }, []);

  /** Set after the hook exists; the report needs the map's length, not a copy of it. */
  const charactersRef = useRef<() => number>(() => 0);

  const onChange = useCallback(
    (next: SpanSelection | null) => {
      /**
       * The ref, **then** the state. A whole gesture can arrive inside one task
       * — every move and the release — so React has not re-rendered and the ref
       * is the only up-to-date copy. Reporting from state alone meant the
       * release's report overwrote the correct one the last move had just
       * written, with `null`.
       */
      spanRef.current = next;
      setSpan(next);
      report(next);
    },
    [report],
  );

  const spanSelect = useSpanSelect({
    selection: span ? { from: span.from, to: span.to } : null,
    revision: runs,
    onChange,
    onCommit: onChange,
    onMove: (ms) => moves.current.push(ms),
    // "Tap the first character, then tap the last", with no other control to
    // find — which is the degrade C5a specifies and `ios.md` I2 exercises.
    armsOnTap: true,
    onReady: (info) => {
      setCharacters(info.characters);
      // Report straight away: `ios.md` I2 opens this page and reads the
      // instrumentation before touching anything. An instrument that only
      // exists after the first gesture is not an instrument.
      report(spanRef.current);
    },
  });
  charactersRef.current = spanSelect.characters;

  // Frame accounting while a drag is in flight: the budget C5a sets is one
  // frame (16.7 ms) for the whole move → highlight update.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      if (spanSelect.dragging.current) {
        frames.current.frames += 1;
        if (now - last > 20) frames.current.dropped += 1;
      }
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [spanSelect.dragging]);

  const selected = span?.text ?? '';

  return (
    <div className="flex flex-col gap-4 p-4" data-testid={HARNESS_MARKER}>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <span data-testid="caret-api">caret: {spanSelect.api}</span>
        <span data-testid="highlight-api">highlight: {spanSelect.highlights ? 'yes' : 'no'}</span>
        <span data-testid="span-report">span: {span ? `${span.from}–${span.to}` : '—'}</span>
        <span data-testid="span-characters">characters: {characters}</span>
        {spanSelect.anchor !== null ? <span data-testid="span-to-here">…to here</span> : null}
      </div>

      {/*
        **One line, always, and that is load-bearing.**

        This readout sits above the passage and grew with the selection. Once
        the selected string wrapped, the whole passage below was pushed down a
        line box mid-drag — so the finger landed on an earlier character, the
        selection shrank, the readout shrank, the passage rose, and the span
        oscillated: measured at 390px as jumps of 12–18 characters against a
        uniform 32px per move. The phase's entire output is an instrument and
        `ios.md` I2 reads it on a device, so a readout that moves the thing
        being measured is a defect in the measurement. Pinning the height to one
        `text-sm` line box held the passage still and made the same gesture
        strictly monotone.

        The text is clipped, not shortened: `textContent` is intact for the spec
        and for anyone reading the DOM.
      */}
      <p className="h-5 truncate text-sm" data-testid="span-text">
        {selected || '(nothing selected)'}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          data-testid="span-copy"
          disabled={!span}
          onClick={() => {
            // The span's own base characters — no `<rt>` text, because the app
            // chooses the string rather than the engine deriving it from the
            // DOM. Production does exactly this in `span-clipboard.ts`.
            setCopied(selected);
            void writeSpan(selected);
          }}
        >
          Copy the span
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="span-clear"
          onClick={() => {
            setSpan(null);
            spanRef.current = null;
            spanSelect.setAnchor(null);
            spanSelect.clearPaint();
            report(null);
          }}
        >
          Clear
        </Button>
        {copied === undefined ? null : (
          <span data-testid="span-copied" className="self-center text-xs text-muted">
            copied {copied.length} characters
          </span>
        )}
      </div>

      <HanziText
        data-testid="span-passage"
        runs={runs}
        display="always"
        spanSelect={spanSelect}
        span={span ? { from: span.from, to: span.to } : null}
        // No `select-none` here: `<HanziText>` applies `.hanzi-span-host` to
        // any container with a span handle, so the harness and the reader
        // cannot drift apart on the one declaration the design rests on.
        className="text-2xl leading-loose"
      />
    </div>
  );
}

/** The one-paragraph passage, for a harness that wants a short one. */
export const SHORT_RUNS = PASSAGE_RUNS;
