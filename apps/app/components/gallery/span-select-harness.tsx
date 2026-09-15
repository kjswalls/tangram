'use client';

/**
 * The drag-select harness (docs/plans/core.md C5a).
 *
 * **The riskiest single piece of UI in the project**, built here as a harness
 * and a set of numbers before any production code exists. Both mobile audits
 * reached the same conclusion independently: the platform's own text selection
 * is unusable on a reader, because it sweeps the `<rt>` pinyin into the
 * selection and the clipboard, its precision degrades from characters to lines
 * as the selection grows, and its handles and callout menu fight the dictionary
 * UI.
 *
 * **Nothing here is a production reader file, and that is the point of the
 * split rather than a preference.** `ios.md` I2 — the physical-device crash
 * check that STACK register #1 rests on — loads *this harness*, and `ios.md`
 * §4.4 says no C5b production file may land before I2 answers. So the harness
 * attaches its pointer handlers to its own container and hit-tests into
 * whatever DOM is underneath, which means it needs **no prop and no edit on
 * `<HanziText>`**. It renders one, unchanged, because a harness over different
 * markup would measure a different thing.
 *
 * ## The gesture, and why `touch-action` is dynamic
 *
 * AUDIT 1 (iOS) says "`touch-action: none` on the reader container"; AUDIT 2
 * (Android) says "`touch-action` handling **on pointer-down**". STACK §2.1
 * flattened both into the iOS wording, and a static `touch-action: none` is
 * exactly the declaration that stops the browser panning that element — on the
 * one screen made of a long scrolling passage. AUDIT 2's version is the one
 * that works:
 *
 *  1. the passage rests at **`touch-action: pan-y`** — a vertical drag is the
 *     browser's, it scrolls, and the app never sees it;
 *  2. `pointerdown` records the origin and does nothing else: no capture, no
 *     `preventDefault`;
 *  3. `pointermove` discriminates the axis. Once the gesture is unambiguously
 *     horizontal, `setPointerCapture`, `preventDefault()`, and select;
 *  4. `touch-action: none` for the duration of the captured drag — **after**
 *     capture, never before.
 *
 * ## Hit-testing and painting
 *
 * `caretPositionFromPoint` where it exists (Chrome 128+; WebKit landed it
 * behind a flag in late 2024 and whether Safari 26 ships it on is unverified —
 * register #2), else `caretRangeFromPoint`, which is WebKit-proprietary and
 * ancient in Blink. **Which path was taken is reported, not assumed.** The span
 * is painted with the **CSS Custom Highlight API**, so a pointer move costs no
 * DOM mutation.
 *
 * ## The fallback is not dead code
 *
 * With neither caret API present the harness degrades to **tap the first
 * character, then tap the last** — the current `extend()` model generalised to
 * characters. It needs no `caretRangeFromPoint`, no Custom Highlight API and no
 * `pointermove`, and it is feature-detected at runtime so it is exercised in
 * normal operation rather than discovered in a crisis.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PASSAGE_RUNS, passageRuns } from '@/components/gallery/passage';
import { HanziText } from '@/components/hanzi/hanzi-text';
import { Button } from '@/components/ui/button';

/** The URL `ios.md` I2 opens on the device. Recorded in HANDOFF.md. */
export const HARNESS_PATH = '/span-select';

/** The name the Custom Highlight API registers the painted span under. */
export const HIGHLIGHT_NAME = 'span-select';

/**
 * Horizontal travel, in CSS pixels, before a gesture counts as a sweep.
 *
 * **A value to record, not a value to assume** — no audit measured one. Eight
 * is what the harness shows separates a deliberate horizontal sweep from the
 * horizontal drift in a thumb's vertical scroll on a 390px passage: below it a
 * synthetic "near-vertical with a few pixels of drift" drag never commits, and
 * a horizontal drag of the same magnitude always does. The companion rule
 * matters as much as the number: the gesture must also be **more** horizontal
 * than vertical, so a long vertical drag with 20px of drift is still the
 * browser's. See HANDOFF.md; `ios.md` and `android.md` re-check it on hardware,
 * where thumbs are less precise than Playwright.
 */
export const AXIS_THRESHOLD_PX = 8;

export type CaretApi = 'caretPositionFromPoint' | 'caretRangeFromPoint' | 'none';

/**
 * The two caret APIs, as *optional* members.
 *
 * Not an `extends Document`: the DOM lib now types `caretPositionFromPoint` as
 * required, which is the claim this whole phase is checking rather than
 * assuming — WebKit landed it behind a flag in late 2024 and whether Safari 26
 * ships it on is register #2, unverified. A type that says it is always there
 * would make the feature detection below unreachable.
 */
interface CaretDocument {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

/** Which caret API this engine offers. Feature-detected, never inferred. */
export function detectCaretApi(doc: Document = document): CaretApi {
  const candidate = doc as unknown as CaretDocument;
  if (typeof candidate.caretPositionFromPoint === 'function') return 'caretPositionFromPoint';
  if (typeof candidate.caretRangeFromPoint === 'function') return 'caretRangeFromPoint';
  return 'none';
}

function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS;
}

/** One base text node and the index into the passage its first character has. */
interface Piece {
  node: Text;
  start: number;
}

interface CharMap {
  pieces: Piece[];
  /** The passage's base characters, `<rt>` and `<rp>` excluded. */
  text: string;
}

/**
 * The passage's base text, mapped to its DOM.
 *
 * `<rt>` and `<rp>` are skipped **here**, once, which is what makes "the
 * highlight never covers an `<rt>`" true by construction rather than by a later
 * filter: every range the harness builds comes out of this list.
 */
export function buildCharMap(root: HTMLElement): CharMap {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
        if (el.tagName === 'RT' || el.tagName === 'RP') return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const pieces: Piece[] = [];
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? '';
    if (!value) continue;
    pieces.push({ node: node as Text, start: text.length });
    text += value;
  }
  return { pieces, text };
}

function indexOfNode(map: CharMap, node: Node, offset: number): number | undefined {
  for (const piece of map.pieces) {
    if (piece.node === node) return piece.start + offset;
  }
  // An element was hit rather than a text node — `caretRangeFromPoint` does that
  // at the very edge of a line. Take the first base text node inside it.
  if (node.nodeType === Node.ELEMENT_NODE) {
    for (const piece of map.pieces) {
      if ((node as Element).contains(piece.node)) return piece.start;
    }
  }
  return undefined;
}

/** The character under a point, as an index into the passage. */
/**
 * The character a caret boundary names, given where the point actually is.
 *
 * `caretPositionFromPoint` returns a **boundary**, and it snaps to the nearer
 * one: a point in the right half of character *c* comes back as `c + 1`. So the
 * raw index is off by one for half of every character, which the first run of
 * the drag spec showed as a span of 4–8 for a drag from 3 to 7. The boundary is
 * disambiguated by asking which character's box the point is in — one range and
 * one rect per move, and the cost is inside the `pointermove` measurement
 * rather than hidden from it.
 */
function characterAt(map: CharMap, boundary: number, x: number): number {
  const left = boundary - 1;
  if (left >= 0) {
    const rect = rangesFor(map, left, left)[0]?.getBoundingClientRect();
    if (rect && x >= rect.left && x <= rect.right) return left;
  }
  return Math.max(0, Math.min(map.text.length - 1, boundary));
}

export function indexFromPoint(
  map: CharMap,
  x: number,
  y: number,
  api: CaretApi,
  doc: Document = document,
): number | undefined {
  const candidate = doc as unknown as CaretDocument;
  let node: Node | undefined;
  let offset = 0;
  if (api === 'caretPositionFromPoint' && candidate.caretPositionFromPoint) {
    const position = candidate.caretPositionFromPoint(x, y);
    if (position) {
      node = position.offsetNode;
      offset = position.offset;
    }
  } else if (api === 'caretRangeFromPoint' && candidate.caretRangeFromPoint) {
    const range = candidate.caretRangeFromPoint(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node) return undefined;
  const boundary = indexOfNode(map, node, offset);
  if (boundary === undefined) return undefined;
  return characterAt(map, boundary, x);
}

/** Ranges covering `[from, to]` inclusive, over base text nodes only. */
export function rangesFor(map: CharMap, from: number, to: number): Range[] {
  const start = Math.min(from, to);
  const end = Math.max(from, to) + 1;
  const ranges: Range[] = [];
  for (const piece of map.pieces) {
    const pieceEnd = piece.start + (piece.node.nodeValue?.length ?? 0);
    const lo = Math.max(start, piece.start);
    const hi = Math.min(end, pieceEnd);
    if (lo >= hi) continue;
    const range = piece.node.ownerDocument.createRange();
    range.setStart(piece.node, lo - piece.start);
    range.setEnd(piece.node, hi - piece.start);
    ranges.push(range);
  }
  return ranges;
}

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
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<CharMap>({ pieces: [], text: '' });

  const [api, setApi] = useState<CaretApi>('none');
  const [highlights, setHighlights] = useState(false);
  const [span, setSpan] = useState<{ from: number; to: number } | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [copied, setCopied] = useState<string>();

  const origin = useRef<{ x: number; y: number; id: number } | null>(null);
  /**
   * The anchor the pointer handlers read. Declared here rather than mirrored
   * from state at the bottom of the component: a burst of moves inside one task
   * never sees a state update, so the ref is the source of truth for the drag
   * and `anchor` is the source of truth for what is drawn.
   */
  const anchorRef = useRef<number | null>(null);
  const spanRef = useRef<{ from: number; to: number } | null>(null);
  const dragging = useRef(false);
  const moves = useRef<number[]>([]);
  const frames = useRef({ frames: 0, dropped: 0 });

  // Detection happens on the client, once, and is *reported*: register #2 is
  // open precisely because nobody has verified which path Safari 26 takes.
  useEffect(() => {
    setApi(detectCaretApi());
    setHighlights(highlightsSupported());
  }, []);

  /**
   * The map is rebuilt from the DOM after every render of the passage, and
   * `data-span-index` is stamped on each character element.
   *
   * The stamp is the harness's own decoration of its own container — a spec has
   * to be able to say "character 3" and get a box — and it is deliberately not
   * a change to `<HanziText>`, which C5a may not touch.
   */
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    map.current = buildCharMap(root);
    /**
     * Stamped from the **char map**, not from a running count of elements.
     *
     * Counting elements looked equivalent and is not: a run the dictionary has
     * no reading for — every punctuation mark in the passage — renders as one
     * plain `<span>` with no `data-char-index`, so its characters are in the
     * map and have no element. A counter therefore drifted out of step with the
     * map at the first comma, and every assertion about "character N" after it
     * was about a different character.
     */
    for (const element of root.querySelectorAll<HTMLElement>('[data-char-index]')) {
      const first = element.firstChild;
      const piece = map.current.pieces.find(
        (candidate) => candidate.node === first || element.contains(candidate.node),
      );
      if (piece) element.dataset.spanIndex = String(piece.start);
    }
    // Report straight away: `ios.md` I2 opens this page and reads the
    // instrumentation before touching anything, and a spec asks how long the
    // passage is before it drags. An instrument that only exists after the
    // first gesture is not an instrument.
    reportRef.current(null);
  }, [runs]);

  const paint = useCallback(
    (from: number, to: number) => {
      const root = container.current;
      if (!root) return;
      if (!highlightsSupported()) return;
      const ranges = rangesFor(map.current, from, to);
      const registry = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
      const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown })
        .Highlight;
      if (!HighlightCtor) return;
      registry.set(HIGHLIGHT_NAME, new HighlightCtor(...ranges));
    },
    [],
  );

  const clearPaint = useCallback(() => {
    if (!highlightsSupported()) return;
    (CSS as unknown as { highlights: Map<string, unknown> }).highlights.delete(HIGHLIGHT_NAME);
  }, []);

  const report = useCallback((next: { from: number; to: number } | null) => {
    const text = next
      ? map.current.text.slice(Math.min(next.from, next.to), Math.max(next.from, next.to) + 1)
      : '';
    window.__spanSelect = {
      api: detectCaretApi(),
      characters: map.current.text.length,
      highlights: highlightsSupported(),
      moves: [...moves.current],
      droppedFrames: frames.current.dropped,
      frames: frames.current.frames,
      span: next,
      text,
    };
  }, []);

  const reportRef = useRef(report);
  reportRef.current = report;

  const commit = useCallback(
    (from: number, to: number) => {
      const next = { from: Math.min(from, to), to: Math.max(from, to) };
      /**
       * The ref, **then** the state.
       *
       * `endDrag` reports `spanRef.current`, and a whole gesture can arrive
       * inside one task — every move and the release — so React has not
       * re-rendered and the ref is the only up-to-date copy. Setting only the
       * state meant the release's report overwrote the correct one the last
       * move had just written, with `null`.
       */
      spanRef.current = next;
      setSpan(next);
      paint(next.from, next.to);
      report(next);
    },
    [paint, report],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Record and nothing else: no capture, no preventDefault. Whatever this
    // gesture turns out to be, the browser still owns it at this instant.
    origin.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
    dragging.current = false;
    moves.current = [];
    frames.current = { frames: 0, dropped: 0 };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const started = origin.current;
    if (!started || started.id !== event.pointerId) return;
    const t0 = performance.now();

    if (!dragging.current) {
      const dx = Math.abs(event.clientX - started.x);
      const dy = Math.abs(event.clientY - started.y);
      // Unambiguously horizontal, both ways: far enough to be deliberate, and
      // more horizontal than vertical. A long vertical drag with a lot of drift
      // stays the browser's.
      if (dx < AXIS_THRESHOLD_PX || dx <= dy) return;
      dragging.current = true;
      /**
       * Capture is best-effort.
       *
       * `setPointerCapture` throws `NotFoundError` for a pointer id the browser
       * is not tracking — a synthetic `PointerEvent`, which is how a spec
       * drives touch, and in the wild a pointer that has already been cancelled.
       * The selection does not depend on capture; capture only keeps the moves
       * coming when the finger leaves the element. Throwing here would abandon
       * the gesture instead.
       */
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* not a tracked pointer; the gesture continues without capture */
      }
      // Only now, and only for the duration of the captured drag.
      event.currentTarget.style.touchAction = 'none';
      const from = indexFromPoint(map.current, started.x, started.y, detectCaretApi());
      /**
       * The ref first, and the state only for the UI.
       *
       * `setAnchor` is asynchronous, and a drag's `pointermove` events can all
       * arrive inside one task — which is exactly what a synthetic touch
       * sequence does, and what a fast real drag does too. Reading the anchor
       * out of React state meant every move in that burst saw `null` and
       * committed nothing: the span came back empty for the whole gesture.
       */
      anchorRef.current = from ?? null;
      setAnchor(from ?? null);
    }

    event.preventDefault();
    const at = indexFromPoint(map.current, event.clientX, event.clientY, detectCaretApi());
    const from = anchorRef.current;
    if (at !== undefined && from !== null && from !== undefined) commit(from, at);
    moves.current.push(performance.now() - t0);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!origin.current) return;
    if (dragging.current) {
      event.currentTarget.style.touchAction = 'pan-y';
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch {
        /* never captured */
      }
    }
    origin.current = null;
    dragging.current = false;
    report(spanRef.current);
  };

  /**
   * The fallback: two taps, no `pointermove` at all.
   *
   * Engaged whenever the caret APIs are absent, which is what makes it
   * exercised rather than hypothetical. It hit-tests by **element** —
   * `data-span-index`, which the effect above stamps — so it needs neither
   * caret API nor the Custom Highlight API.
   */
  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (api !== 'none') return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-span-index]');
    if (!target) return;
    const index = Number(target.dataset.spanIndex);
    if (Number.isNaN(index)) return;
    if (anchor === null) {
      anchorRef.current = index;
      setAnchor(index);
      setSpan(null);
      clearPaint();
      report(null);
      return;
    }
    commit(anchor, index);
    anchorRef.current = null;
    setAnchor(null);
  };



  // Frame accounting while a drag is in flight: the budget C5a sets is one
  // frame (16.7 ms) for the whole move → highlight update, and nobody has
  // measured it, so the first run is the baseline.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      if (dragging.current) {
        frames.current.frames += 1;
        if (now - last > 20) frames.current.dropped += 1;
      }
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const selected = span
    ? map.current.text.slice(span.from, span.to + 1)
    : '';

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="span-select-harness">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <span data-testid="caret-api">caret: {api}</span>
        <span data-testid="highlight-api">highlight: {highlights ? 'yes' : 'no'}</span>
        <span data-testid="span-report">
          span: {span ? `${span.from}–${span.to}` : '—'}
        </span>
        {api === 'none' && anchor !== null ? (
          <span data-testid="span-to-here">…to here</span>
        ) : null}
      </div>

      <p className="text-sm" data-testid="span-text">
        {selected || '(nothing selected)'}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          data-testid="span-copy"
          disabled={!span}
          onClick={() => {
            // The harness derives the string from its OWN character index, so
            // what lands on the clipboard is base characters and nothing else.
            // C5b promotes this into `span-clipboard.ts`, where it reads
            // `spanOf()` instead, rather than inventing it twice.
            const text = selected;
            setCopied(text);
            void navigator.clipboard?.writeText(text).catch(() => undefined);
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
            setAnchor(null);
            anchorRef.current = null;
            spanRef.current = null;
            clearPaint();
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

      <div
        ref={container}
        data-testid="span-passage"
        // Rests at `pan-y`: a vertical drag is the browser's. The handlers take
        // it to `none` only after capture.
        style={{ touchAction: 'pan-y' }}
        className="select-none text-2xl leading-loose"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={onClick}
      >
        <HanziText runs={runs} display="always" data-testid="span-passage-text" />
      </div>
    </div>
  );
}

/** The one-paragraph passage, for a harness that wants a short one. */
export const SHORT_RUNS = PASSAGE_RUNS;
