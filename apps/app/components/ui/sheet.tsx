'use client';

/**
 * The sheet (docs/plans/core.md C1) — a bottom sheet on phones, a side panel at
 * wide widths. The reader tap, the word sheet and the character sheet all need
 * one and there is no dialog primitive in the app today.
 *
 * **Hand-rolled rather than `<dialog>`.** `showModal()` would give the focus
 * trap and the top layer for free, but it also gives a UA-controlled backdrop,
 * a close-on-Escape this component has to intercept anyway, and — the reason
 * that settles it — the sheet has to be *dismissible by a drag on a phone* and
 * has to not take the top layer away from a future toast. The trap below is
 * twenty lines and is unit-tested.
 *
 * **Why the phone layout is what it is** (§1): at 390px it covers the lower two
 * thirds, so the character that was tapped stays visible above it. The caller
 * scrolls the tapped element clear; this only promises not to cover it.
 *
 * **The switch to the side panel is at 720px, not Tailwind's `md` (768px).**
 * §1 puts the wide shell at "~720px and above", and `md:` would leave a 48px
 * band in which the wide shell rendered a phone-shaped bottom sheet — which is
 * R7 ("the two shells drift into two designs") in miniature. C1 is the first
 * file that needs the number, so C1 states it: `--breakpoint-wide: 45rem` in
 * `app/tokens.css`, used here as the `wide:` variant. **C7's two shells use the
 * same variant**; nothing in the app may hard-code 768 for this boundary.
 *
 * Accessibility contract, all asserted in tests/unit/ui/sheet.test.tsx:
 *   - `role="dialog"` + `aria-modal="true"` + a label;
 *   - focus moves into the sheet on open and back to the opener on close;
 *   - Tab and Shift+Tab cycle inside it;
 *   - Escape closes; a press on the backdrop closes; a press inside does not.
 *
 * **`modal={false}` is a real second mode, added at C4 for the reader.** A
 * reading session is tap-a-word, read, tap-the-next-word, and a modal sheet
 * eats the first tap on every word after the first: the backdrop is over the
 * passage, so the tap dismisses rather than opens and the loop costs two
 * gestures a word. Non-modal means, precisely: no backdrop element, no
 * `aria-modal`, no page-scroll lock, and **no Tab trap** — a dialog the user
 * can tab out of is what `role="dialog"` without `aria-modal` describes, and
 * trapping Tab without a backdrop would be the worst of both. Everything else
 * is unchanged: the label, focus moving in on open and back to the opener on
 * close, and Escape.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/cn';

/** Everything focusable, in DOM order. `:not([tabindex="-1"])` keeps the trap honest. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Whether a candidate is really reachable.
 *
 * **Not `offsetParent !== null`**, which is what this was and which is a test
 * that cannot fail: jsdom implements no layout, so `offsetParent` is null for
 * *every* element, the candidate list collapsed to whichever node already had
 * focus, and every Tab re-focused it — so the unit tests passed with the wrap
 * direction inverted, or with no wrap at all. (It is also null for a
 * `position: fixed` subtree in a real browser, which is exactly what this
 * component is.) The checks below are the ones that mean the same thing in
 * jsdom and in Chromium.
 */
function isReachable(node: HTMLElement): boolean {
  if (node.hasAttribute('hidden')) return false;
  if (node.getAttribute('aria-hidden') === 'true') return false;
  const style = node.ownerDocument.defaultView?.getComputedStyle(node);
  return !style || (style.display !== 'none' && style.visibility !== 'hidden');
}

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * Default true. `false` gives a non-modal dialog — see the header. The
   * reader passes it; every other caller wants the default.
   */
  modal?: boolean;
  /** The accessible name. Rendered as the sheet's heading unless `hideTitle`. */
  title: string;
  hideTitle?: boolean;
  children: ReactNode;
  /** Right of the heading: a close button is provided, this is anything else. */
  aside?: ReactNode;
  className?: string;
  'data-testid'?: string;
}

export function Sheet({
  open,
  onClose,
  modal = true,
  title,
  hideTitle,
  children,
  aside,
  className,
  'data-testid': testId = 'sheet',
}: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();

  /**
   * `onClose` through a ref, so the open/close effect does not depend on it.
   *
   * Callers pass an inline arrow — `onClose={() => setCharacter(undefined)}` is
   * the character sheet's — which is a new identity on every render. With
   * `onClose` in the effect's dependency list the effect tore down and re-ran
   * on every render, re-capturing `opener.current` as whatever inside the panel
   * had focus by then; Escape then "returned" focus to the sheet that had just
   * closed, i.e. to nothing. The effect must run on `open` and `modal` only.
   */
  const close = useRef(onClose);
  close.current = onClose;

  // Remember who opened it *before* focus moves, and give it back on close.
  // The same effect locks the page behind it: without that, a wheel or a touch
  // drag over the dimmed backdrop scrolls the document under the sheet — which
  // on a phone is the common miss, and which undoes the one thing §1 promises
  // about a sheet, that the character the learner tapped stays visible above
  // it. The caller scrolls that character clear; this keeps it there.
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();

    /**
     * **Escape on the document when non-modal.** The handler below is on the
     * panel, which is enough while a backdrop and a Tab trap keep focus inside
     * it — and is dead the moment focus leaves, which in the reader is the
     * *normal* case: tapping the next word moves focus onto that token and
     * Escape stopped closing the sheet. A capture-phase document listener is
     * the non-modal equivalent of the trap.
     */
    const onDocumentKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (panel.current?.contains(event.target as Node)) return; // the panel's own handler
      close.current();
    };
    if (!modal) document.addEventListener('keydown', onDocumentKey);

    // Captured for the cleanup: by the time it runs, the ref has been cleared.
    const node = panel.current;
    const { body } = document;
    const previousOverflow = body.style.overflow;
    const previousGutter = body.style.scrollbarGutter;
    // Only when modal: a non-modal sheet leaves the page usable, and a page you
    // can reach but cannot scroll is worse than either.
    if (modal) {
      body.style.overflow = 'hidden';
      // Without this the page jumps sideways by the scrollbar's width on a
      // pointer device the moment the sheet opens.
      body.style.scrollbarGutter = 'stable';
    }

    return () => {
      document.removeEventListener('keydown', onDocumentKey);
      body.style.overflow = previousOverflow;
      body.style.scrollbarGutter = previousGutter;
      const back = opener.current;
      opener.current = null;
      /**
       * Give focus back **only if the sheet was holding it**.
       *
       * Modal, it always was. Non-modal, the learner may have moved on — in the
       * reader they have, onto the next word they tapped — and yanking focus
       * back to whatever opened the sheet several taps ago would take the
       * keyboard off what they are actually doing. `opener` is stale in that
       * case too: it is captured when `open` goes true, and the reader keeps
       * one sheet open across taps.
       *
       * "Was holding it" has two shapes by the time this cleanup runs: focus is
       * still inside the panel (it has not been detached yet), or it has fallen
       * to `body` because the element that had it was just removed. Anything
       * else is a live element elsewhere, and belongs to the learner.
       */
      const active = document.activeElement;
      const held = active === null || active === document.body || Boolean(node?.contains(active));
      if (held && back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, [open, modal]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      // No Tab trap when non-modal: the page behind is reachable by design.
      if (event.key !== 'Tab' || !modal) return;
      const nodes = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
        (node) => isReachable(node) || node === document.activeElement,
      );
      if (nodes.length === 0) {
        event.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (active === null || !panel.current?.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    },
    [modal, onClose],
  );

  if (!open) return null;

  return (
    <div
      data-testid={`${testId}-layer`}
      data-modal={modal ? 'true' : 'false'}
      className={cn(
        'fixed inset-0 z-40 flex items-end justify-center wide:items-stretch wide:justify-end',
        // Non-modal: the layer is a positioning frame and nothing else, so a
        // tap lands on the page behind it. The panel takes its events back.
        !modal && 'pointer-events-none',
      )}
    >
      {/*
        The backdrop is a plain div with a pointer handler, not a button: a
        button here lands in the tab ring as an unlabelled control between the
        page and the sheet. Escape and the close button are the keyboard paths.
      */}
      {modal ? (
        <div
          data-testid={`${testId}-backdrop`}
          aria-hidden
          onMouseDown={onClose}
          className="absolute inset-0 bg-ink/30"
        />
      ) : null}
      <div
        ref={panel}
        role="dialog"
        {...(modal ? { 'aria-modal': true as const } : {})}
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        onKeyDown={onKeyDown}
        className={cn(
          'pointer-events-auto relative flex w-full flex-col overflow-y-auto overscroll-contain border-border bg-surface',
          // Phone: **the lower two thirds** — §1's fact is two-sided, so this
          // is a floor as well as a cap. A cap alone let a short sheet render
          // as a strip pinned to the bottom edge, which is not the surface the
          // learner is now working in. `overflow-y-auto` above handles the
          // other direction.
          'max-h-[66dvh] min-h-[50dvh] rounded-t-[var(--r-lg)] border-t',
          // Wide (720px): a side panel, full height, no rounded lip.
          'wide:max-h-none wide:min-h-0 wide:h-full wide:max-w-md wide:rounded-none wide:border-t-0 wide:border-l',
          'pb-[env(safe-area-inset-bottom)]',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3 px-4 pt-4">
          <h2
            id={titleId}
            className={cn(
              'text-sm font-semibold tracking-wide text-muted uppercase',
              hideTitle && 'sr-only',
            )}
          >
            {title}
          </h2>
          <div className="flex items-center gap-2">
            {aside}
            <button
              type="button"
              data-testid={`${testId}-close`}
              onClick={onClose}
              aria-label="Close"
              className="rounded-[var(--r-sm)] px-2 py-1 text-sm text-muted hover:bg-lookup-soft hover:text-ink"
            >
              Close
            </button>
          </div>
        </div>
        <div className="px-4 pt-3 pb-4">{children}</div>
      </div>
    </div>
  );
}
