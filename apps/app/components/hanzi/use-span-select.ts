'use client';

/**
 * Drag to select a span of characters (docs/plans/core.md C5b).
 *
 * **This is C5a's harness logic, promoted.** Nothing in C5a's *design* is
 * re-argued here — the gesture, the caret hit-test, the Custom Highlight API
 * painting, the two-tap degrade and the axis rule are all the same, and every
 * fix the C5a adversarial review landed came across with them, named in the
 * comments where it bites. What changes is that it now runs over the real
 * passage, and that `components/gallery/span-select-harness.tsx` drives *this*
 * module rather than a second copy of it: a harness that has drifted from the
 * production hook is worth nothing to `ios.md` on the next device run.
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
 * **`touch-action` does not apply to a non-replaced inline element**, so the
 * element these handlers go on has to be a block. `<HanziText>` renders its
 * root as a `<div>` when a span handler is attached, for exactly that reason.
 *
 * ## The character index
 *
 * Every index in this module is an index into the container's **base text** —
 * `<rt>` and `<rp>` excluded, because they are skipped when the map is built
 * rather than filtered afterwards. That is what makes "the highlight never
 * covers an `<rt>`" true by construction: every range the hook builds comes out
 * of `CharMap.pieces`.
 *
 * The reader's tokens tile its body exactly (`lib/dict/segment.ts` emits a
 * `text` token for every non-CJK run), so the concatenated base text of a
 * rendered passage **is** the body and an index here is a body offset there.
 * `tests/unit/reader/store.test.ts` asserts the tiling rather than trusting it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * Horizontal travel, in CSS pixels, before a gesture counts as a sweep.
 *
 * **A value recorded, not assumed** — no audit measured one, C5a measured this
 * one and `HANDOFF.md` carries how. Eight is what separates a deliberate
 * horizontal sweep from the horizontal drift in a thumb's vertical scroll on a
 * 390px passage. The companion rule matters as much as the number: the gesture
 * must also be **more** horizontal than vertical, so a long vertical drag with
 * 20px of drift is still the browser's. `ios.md` and `android.md` re-check it
 * on hardware, where thumbs are less precise than Playwright.
 */
export const AXIS_THRESHOLD_PX = 8;

/** The name the Custom Highlight API registers the painted span under. */
export const SPAN_HIGHLIGHT_NAME = 'span-select';

/**
 * The class the **degrade** paints with, when there is no Custom Highlight API.
 *
 * C5a specifies the fallback as one that "paints with a class on the
 * already-per-character DOM". Degrading only on the caret APIs left an engine
 * below Chrome 105 / Safari 17.2 selecting **invisibly**: the span was
 * computed, Copy was enabled, and the learner saw nothing.
 */
export const SELECTED_CLASS = 'span-selected';

export type CaretApi = 'caretPositionFromPoint' | 'caretRangeFromPoint' | 'none';

/**
 * The two caret APIs, as *optional* members.
 *
 * Not an `extends Document`: the DOM lib types `caretPositionFromPoint` as
 * required, which is the claim this design checks rather than assumes — WebKit
 * landed it behind a flag in late 2024 and whether Safari 26 ships it on is
 * register #2, unverified. A type that says it is always there would make the
 * feature detection below unreachable.
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

export function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS;
}

/** One base text node and the index into the passage its first character has. */
interface Piece {
  node: Text;
  start: number;
}

export interface CharMap {
  pieces: Piece[];
  /** The passage's base characters, `<rt>` and `<rp>` excluded. */
  text: string;
}

export const EMPTY_CHAR_MAP: CharMap = { pieces: [], text: '' };

/**
 * One element the class degrade can paint, and the characters it holds.
 *
 * Derived from the **char map's own pieces**, not from a query for
 * `[data-char-index]`: a run the dictionary has no reading for renders as one
 * plain `<span>` with the whole run's text and no per-character elements, so a
 * query misses every punctuation mark in the passage. A piece's parent element
 * is exact for an annotated character and coarse for a plain run — a
 * two-character run paints whole when the span touches either half. That is a
 * visible difference from the Custom Highlight API's exact ranges; it is also
 * the most a class on the existing DOM can do, and it never covers an `<rt>`,
 * because an `<rt>`'s text node is not in the map.
 */
interface PaintTarget {
  element: HTMLElement;
  start: number;
  /** Exclusive. */
  end: number;
}

function paintTargets(map: CharMap): PaintTarget[] {
  const targets: PaintTarget[] = [];
  for (const piece of map.pieces) {
    const element = piece.node.parentElement;
    if (!element) continue;
    targets.push({
      element,
      start: piece.start,
      end: piece.start + (piece.node.nodeValue?.length ?? 0),
    });
  }
  return targets;
}

/**
 * The passage's base text, mapped to its DOM.
 *
 * `<rt>` and `<rp>` are skipped **here**, once — see the header.
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

/**
 * Stamp `data-span-index` on every character element.
 *
 * Stamped from the **char map**, not from a running count of elements.
 * Counting elements looked equivalent and is not: a run the dictionary has no
 * reading for — every punctuation mark in the passage — renders as one plain
 * `<span>` with no `data-char-index`, so its characters are in the map and have
 * no element. A counter therefore drifted out of step with the map at the first
 * comma, and every assertion about "character N" after it was about a different
 * character.
 *
 * It is also what the `<rt>` rescue in `indexFromPoint` hit-tests against, and
 * what the two-tap degrade hit-tests against, so it is not test scaffolding.
 */
export function stampSpanIndexes(root: HTMLElement, map: CharMap): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-char-index]')) {
    const first = element.firstChild;
    const piece = map.pieces.find(
      (candidate) => candidate.node === first || element.contains(candidate.node),
    );
    if (piece) element.dataset.spanIndex = String(piece.start);
  }
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

/**
 * The character a caret boundary names, given where the point actually is.
 *
 * `caretPositionFromPoint` returns a **boundary**, and it snaps to the nearer
 * one: a point in the right half of character *c* comes back as `c + 1`. So the
 * raw index is off by one for half of every character, which the first run of
 * C5a's drag spec showed as a span of 4–8 for a drag from 3 to 7. The boundary
 * is disambiguated by asking which character's box the point is in — one range
 * and one rect per move, and the cost is inside the `pointermove` measurement
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

/** The character under a point, as an index into the passage's base text. */
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
  if (node) {
    const boundary = indexOfNode(map, node, offset);
    if (boundary !== undefined) return characterAt(map, boundary, x);
  }
  /**
   * **The pinyin band, which the caret API answers and the char map cannot.**
   *
   * An `<rt>` renders *above* its `<ruby>`'s box, and `caretPositionFromPoint`
   * happily returns the `<rt>`'s own text node for a point in it — measured at
   * 390px as a ~13px band per line, sitting directly over the pinyin, which is
   * the most natural thing for a thumb to aim at. That node is in no piece (the
   * TreeWalker rejected it), so `indexOfNode` returns `undefined` and the whole
   * gesture would die silently: no highlight, no span, and no signal
   * distinguishing it from a broken app.
   *
   * **A rescue for a caret API that answered, not a third hit-test.** With no
   * caret API at all the answer stays `undefined`, so the drag path still goes
   * quiet and the two-tap degrade is still what engages.
   */
  if (api === 'none') return undefined;
  const element = (doc as Document).elementFromPoint?.(x, y) ?? null;
  const stamped = (element as HTMLElement | null)?.closest<HTMLElement>('[data-span-index]');
  if (!stamped) return undefined;
  const index = Number(stamped.dataset.spanIndex);
  return Number.isNaN(index) ? undefined : index;
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

export interface SpanSelection {
  /** First character of the span, inclusive. */
  from: number;
  /** Last character of the span, inclusive. */
  to: number;
  /** The base characters themselves — no `<rt>` text, ever. */
  text: string;
}

/**
 * Pull both ends of a raw span inward to characters that may be an endpoint.
 *
 * C5b's rule, in its own words: "A drag that starts or ends on a run of
 * punctuation snaps inward to the nearest Chinese character; a drag across one
 * passes through it." The *interior* is untouched — a span that crosses a comma
 * contains the comma — because `spanOf()` slices the body and a span missing
 * its own punctuation is not a substring of what the learner dragged across.
 *
 * `null` when the drag found no valid endpoint at all (a sweep entirely over
 * punctuation or Latin), which is a span that must not be reported rather than
 * one silently widened to something the learner did not choose.
 */
export function snapSpan(
  text: string,
  from: number,
  to: number,
  isEndpoint: (char: string) => boolean,
): SpanSelection | null {
  let lo = Math.max(0, Math.min(from, to));
  let hi = Math.min(text.length - 1, Math.max(from, to));
  if (hi < lo) return null;
  while (lo <= hi && !isEndpoint(text[lo])) lo += 1;
  while (hi >= lo && !isEndpoint(text[hi])) hi -= 1;
  if (hi < lo) return null;
  return { from: lo, to: hi, text: text.slice(lo, hi + 1) };
}

export interface UseSpanSelectOptions {
  /** Off entirely when false: no handlers run and nothing is painted. */
  enabled?: boolean;
  /**
   * The span to paint, in base-character indexes. The **owner** holds the
   * selection — the reader store, the harness's own state — and this hook
   * paints what it is told. During a drag the hook also paints imperatively,
   * because a whole gesture can arrive inside one task and React will not have
   * re-rendered; the effect then repaints the same thing, which is idempotent.
   */
  selection?: { from: number; to: number } | null;
  /** Rebuild the character map when this changes (a new passage, a re-render). */
  revision?: unknown;
  /** Which characters may be a span **endpoint**. Defaults to all of them. */
  isEndpoint?: (char: string) => boolean;
  /** Every commit during a drag, so an owner can paint a live readout. */
  onChange?: (span: SpanSelection | null) => void;
  /** The release, and the second tap of the degrade. The result of the gesture. */
  onCommit?: (span: SpanSelection | null) => void;
  /** `pointermove` handler time in ms, one sample per move. C5a's instrument. */
  onMove?: (ms: number) => void;
  /** The map was rebuilt: how long the passage is, and what this engine offers. */
  onReady?: (info: { characters: number; api: CaretApi; highlights: boolean }) => void;
  /** Overridden only by a second consumer that must not fight the first's paint. */
  highlightName?: string;
  /**
   * With no caret API, should a plain tap on the text **arm** the degrade?
   *
   * The harness says yes: its whole gesture is "tap the first character, then
   * tap the last", with no other control to find. The reader says no, because
   * its first tap has to keep opening the word sheet — it arms from an explicit
   * "Select to…" control instead, which is also the only version of the degrade
   * a keyboard can reach.
   */
  armsOnTap?: boolean;
}

export interface SpanSelectHandlers {
  style: { touchAction: 'pan-y' };
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
}

export interface SpanSelect {
  /** Attach to the container whose base text the indexes are into. */
  ref: (node: HTMLElement | null) => void;
  /** Spread onto that same container. */
  handlers: SpanSelectHandlers;
  api: CaretApi;
  highlights: boolean;
  /**
   * The degrade's armed anchor, or `null`. Non-null means "the next tap ends
   * the span", which is what a "…to here" affordance renders.
   */
  anchor: number | null;
  /** True while a pointer gesture is actually selecting. Read by an animation loop. */
  dragging: { readonly current: boolean };
  /** Arm the two-tap degrade at `index`, or disarm it with `null`. */
  setAnchor: (index: number | null) => void;
  /**
   * Arm from a tap on the text: drops whatever span was showing first, because
   * a tap that starts a new span has ended the old one. `<HanziText>` calls it
   * when `armsOnTap` is set and the engine has no caret API.
   */
  armFromTap: (index: number) => void;
  /** Whether a plain tap arms the degrade. See `UseSpanSelectOptions`. */
  armsOnTap: boolean;
  /** Close the degrade's span at `index`; a no-op when no anchor is armed. */
  toHere: (index: number) => void;
  /** The base text the indexes are into. Empty before the first map build. */
  textOf: (from: number, to: number) => string;
  characters: () => number;
  /** Drop the paint. The owner still owns the selection. */
  clearPaint: () => void;
}

export function useSpanSelect(options: UseSpanSelectOptions = {}): SpanSelect {
  const {
    enabled = true,
    selection = null,
    revision,
    isEndpoint,
    onChange,
    onCommit,
    onMove,
    onReady,
    highlightName = SPAN_HIGHLIGHT_NAME,
    armsOnTap = false,
  } = options;

  /**
   * The container as **state**, not a ref.
   *
   * The map is rebuilt in an effect, and an effect that reads a ref cannot know
   * the node changed: a remount with the same `revision` — which is every
   * re-mount of the reader — would leave the hook indexing a detached DOM and
   * painting nothing, silently. State puts the node in the dependency list.
   */
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const map = useRef<CharMap>(EMPTY_CHAR_MAP);
  const targets = useRef<PaintTarget[]>([]);
  const painted = useRef<HTMLElement[]>([]);

  const [api, setApi] = useState<CaretApi>('none');
  const [highlights, setHighlights] = useState(false);
  const [anchor, setAnchorState] = useState<number | null>(null);

  const origin = useRef<{ x: number; y: number; id: number } | null>(null);
  /**
   * The anchor the pointer handlers read. Declared as a ref rather than
   * mirrored from state: a burst of moves inside one task never sees a state
   * update, so the ref is the source of truth for the drag and `anchor` is the
   * source of truth for what is *drawn*.
   */
  const anchorRef = useRef<number | null>(null);
  const spanRef = useRef<SpanSelection | null>(null);
  const dragging = useRef(false);

  // The latest callbacks, so the handlers never go stale and never re-create.
  const callbacks = useRef({ onChange, onCommit, onMove, onReady, isEndpoint });
  callbacks.current = { onChange, onCommit, onMove, onReady, isEndpoint };

  // Detection happens on the client, once, and is *reported*: register #2 is
  // open precisely because nobody has verified which path Safari 26 takes.
  useEffect(() => {
    setApi(detectCaretApi());
    setHighlights(highlightsSupported());
  }, []);

  /** Undo the class degrade. Cheap and idempotent: it walks what it painted. */
  const unpaintClasses = useCallback(() => {
    for (const element of painted.current) element.classList.remove(SELECTED_CLASS);
    painted.current = [];
  }, []);

  const paint = useCallback(
    (from: number, to: number) => {
      if (!container) return;
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown })
        .Highlight;
      if (highlightsSupported() && HighlightCtor) {
        const ranges = rangesFor(map.current, lo, hi);
        const registry = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
        registry.set(highlightName, new HighlightCtor(...ranges));
        return;
      }
      /**
       * **The degrade, and it runs rather than existing.** One class per
       * element that holds a character in the span — a DOM mutation per move,
       * which is what the Custom Highlight API exists to avoid and what this
       * path pays because the alternative is an invisible selection.
       */
      unpaintClasses();
      const next: HTMLElement[] = [];
      for (const target of targets.current) {
        if (target.end <= lo || target.start > hi) continue;
        target.element.classList.add(SELECTED_CLASS);
        next.push(target.element);
      }
      painted.current = next;
    },
    [container, highlightName, unpaintClasses],
  );

  const clearPaint = useCallback(() => {
    unpaintClasses();
    if (!highlightsSupported()) return;
    (CSS as unknown as { highlights: Map<string, unknown> }).highlights.delete(highlightName);
  }, [highlightName, unpaintClasses]);

  /**
   * Rebuild the map after every render of the passage, and stamp the indexes.
   *
   * `revision` is the caller's "the text changed" signal. It is deliberately
   * not derived here: the hook cannot tell a re-render that moved text from one
   * that did not, and a map that indexes a different string highlights the
   * wrong characters.
   */
  useEffect(() => {
    const root = container;
    if (!root || !enabled) {
      map.current = EMPTY_CHAR_MAP;
      targets.current = [];
      return;
    }
    map.current = buildCharMap(root);
    targets.current = paintTargets(map.current);
    painted.current = [];
    stampSpanIndexes(root, map.current);
    // Report straight away: `ios.md` I2 opens the harness on a device and reads
    // the instrument before touching anything. An instrument that only exists
    // after the first gesture is not an instrument.
    callbacks.current.onReady?.({
      characters: map.current.text.length,
      api: detectCaretApi(),
      highlights: highlightsSupported(),
    });
  }, [container, enabled, revision]);

  /**
   * Paint what the owner says is selected.
   *
   * Skipped while a drag is in flight — the drag paints imperatively and this
   * effect would only repaint the same span a beat later — and it is what makes
   * a **tap** paint at all, since a tap never goes through the pointer path.
   */
  const from = selection?.from;
  const to = selection?.to;
  useEffect(() => {
    if (!enabled) return;
    if (dragging.current) return;
    if (from === undefined || to === undefined) {
      clearPaint();
      return;
    }
    paint(from, to);
  }, [enabled, from, to, revision, paint, clearPaint]);

  // The paint is a document-level registry entry; leaving the screen with it
  // set would tint a passage nothing on screen owns any more.
  useEffect(() => () => clearPaint(), [clearPaint]);

  const commit = useCallback(
    (a: number, b: number, final: boolean) => {
      const ok = callbacks.current.isEndpoint;
      const next = ok
        ? snapSpan(map.current.text, a, b, ok)
        : {
            from: Math.min(a, b),
            to: Math.max(a, b),
            text: map.current.text.slice(Math.min(a, b), Math.max(a, b) + 1),
          };
      /**
       * The ref, **then** the callback.
       *
       * The release reports `spanRef.current`, and a whole gesture can arrive
       * inside one task — every move and the release — so React has not
       * re-rendered and the ref is the only up-to-date copy. Reporting only
       * through state meant the release overwrote the correct span the last
       * move had just written, with `null`.
       */
      spanRef.current = next;
      if (next) paint(next.from, next.to);
      else clearPaint();
      callbacks.current.onChange?.(next);
      if (final) callbacks.current.onCommit?.(next);
    },
    [clearPaint, paint],
  );

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    /**
     * **A second finger is not a new gesture.**
     *
     * This used to overwrite `origin` unconditionally. A pinch, a second thumb
     * or a palm landing mid-drag therefore orphaned the drag in flight: the
     * first pointer's moves were dropped by the id guard below, `dragging` was
     * reset to false, and so the teardown's `touch-action: pan-y` never ran —
     * the passage was left at `touch-action: none` **for ever**, on the one
     * screen made of a long scrolling passage.
     */
    if (origin.current && dragging.current) return;
    origin.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
    dragging.current = false;
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const started = origin.current;
      if (!started || started.id !== event.pointerId) return;
      const t0 = performance.now();

      if (!dragging.current) {
        const dx = Math.abs(event.clientX - started.x);
        const dy = Math.abs(event.clientY - started.y);
        // Unambiguously horizontal, both ways: far enough to be deliberate, and
        // more horizontal than vertical. A long vertical drag with a lot of
        // drift stays the browser's.
        if (dx < AXIS_THRESHOLD_PX || dx <= dy) return;
        dragging.current = true;
        /**
         * Capture is best-effort. `setPointerCapture` throws `NotFoundError`
         * for a pointer id the browser is not tracking — a synthetic
         * `PointerEvent`, which is how a spec drives touch, and in the wild a
         * pointer that has already been cancelled. The selection does not
         * depend on capture; capture only keeps the moves coming when the
         * finger leaves the element.
         */
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* not a tracked pointer; the gesture continues without capture */
        }
        // Only now, and only for the duration of the captured drag.
        event.currentTarget.style.touchAction = 'none';
        const at = indexFromPoint(map.current, started.x, started.y, detectCaretApi());
        anchorRef.current = at ?? null;
      }

      event.preventDefault();
      const at = indexFromPoint(map.current, event.clientX, event.clientY, detectCaretApi());
      if (at !== undefined) {
        /**
         * **Anchor late rather than not at all.** The origin is hit-tested
         * once, and a press the hit test cannot name left `anchorRef` null for
         * the life of the gesture — every later move then had a character and
         * nowhere to measure it from. Taking the first nameable point as the
         * anchor costs a few characters of precision on a press that was
         * already off the text, and it is the difference between a slightly
         * short selection and a drag that does nothing at all.
         */
        if (anchorRef.current === null) anchorRef.current = at;
        commit(anchorRef.current, at, false);
      }
      callbacks.current.onMove?.(performance.now() - t0);
    },
    [commit],
  );

  const endDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const started = origin.current;
    // Only the pointer that owns the gesture ends it. A second finger's release
    // is not this drag's release.
    if (!started || started.id !== event.pointerId) return;
    /**
     * **Unconditional, not `if (dragging.current)`.** `touch-action` is only
     * ever `none` because a drag put it there, so restoring it costs nothing
     * when no drag was in flight — and leaving it is how the passage stopped
     * scrolling. React never repairs it on its own: the JSX `style` object is
     * unchanged across renders, so React's style diff writes nothing.
     */
    event.currentTarget.style.touchAction = 'pan-y';
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      /* never captured */
    }
    const wasDragging = dragging.current;
    origin.current = null;
    dragging.current = false;
    // A press with no drag is a tap, and a tap is the caller's business — the
    // word sheet's, in the reader. Only a real gesture commits a span.
    if (wasDragging) {
      anchorRef.current = null;
      callbacks.current.onCommit?.(spanRef.current);
    }
  }, []);

  /**
   * Arm (or disarm) the two-tap degrade.
   *
   * Arming paints nothing. The owner already has a selection on screen — the
   * word that was tapped — and repainting a single character over it would
   * fight the controlled paint below on the very next render, so the armed
   * state is shown by the affordance, not by the passage.
   */
  const setAnchor = useCallback((index: number | null) => {
    anchorRef.current = index;
    setAnchorState(index);
  }, []);

  const armFromTap = useCallback(
    (index: number) => {
      spanRef.current = null;
      clearPaint();
      callbacks.current.onChange?.(null);
      anchorRef.current = index;
      setAnchorState(index);
    },
    [clearPaint],
  );

  const toHere = useCallback(
    (index: number) => {
      const at = anchorRef.current;
      if (at === null) return;
      anchorRef.current = null;
      setAnchorState(null);
      commit(at, index, true);
    },
    [commit],
  );

  const ref = setContainer;

  const textOf = useCallback(
    (a: number, b: number) => map.current.text.slice(Math.min(a, b), Math.max(a, b) + 1),
    [],
  );

  const characters = useCallback(() => map.current.text.length, []);

  return {
    ref,
    handlers: {
      // Rests at `pan-y`: a vertical drag is the browser's. The handlers take
      // it to `none` only after capture.
      style: { touchAction: 'pan-y' },
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
    api,
    highlights,
    anchor,
    dragging,
    setAnchor,
    armFromTap,
    armsOnTap,
    toHere,
    textOf,
    characters,
    clearPaint,
  };
}

/** What a caller does with a finished span. */
export type SpanHandler = (span: SpanSelection | null) => void;

/**
 * The base-character index of whatever element an event landed on, or
 * `undefined` off the text. The two-tap degrade hit-tests by **element** —
 * `data-span-index`, which `stampSpanIndexes` writes — so it needs neither
 * caret API nor the Custom Highlight API, which is what makes it the degrade.
 */
export function spanIndexOfEvent(target: EventTarget | null): number | undefined {
  const element = (target as HTMLElement | null)?.closest<HTMLElement>('[data-span-index]');
  if (!element) return undefined;
  const index = Number(element.dataset.spanIndex);
  return Number.isNaN(index) ? undefined : index;
}
