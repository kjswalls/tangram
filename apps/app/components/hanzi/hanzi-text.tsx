'use client';

/**
 * `<HanziText>` — the component every Chinese run in the app renders through
 * (docs/plans/core.md C3).
 *
 * **One `<ruby>` element per character**, mono-ruby, the reading above. Per-
 * character pairs are one glyph wide, so they wrap naturally in any Chromium
 * version. The WebKit half carries a floor: unprefixed `ruby-position` shipped
 * in **Safari 18.2** (AUDIT 1; STACK §6's floors table), and `ios.md` register
 * #12 records that Capacitor 8's stated iOS 15 minimum is itself a
 * search-snippet fact. The practical risk is cosmetic — `over` is the engine
 * default for horizontal text, so an engine that ignores the declaration lays
 * it out the same way — but the floor is written down here rather than
 * rediscovered. **The `-webkit-ruby-position` question goes to `ios.md`
 * alongside its deployment-target decision; do not add the prefix
 * speculatively.**
 *
 * **The DOM's unit is the character; the token is a grouping over characters.**
 * Each character carries `data-char-index`; each word grouping carries
 * `data-token-index` and, when the caller supplies states, `data-state`. That
 * is what lets a tap resolve to a word by default (rule 2) while a second tap
 * resolves to a character, and it is the shape C5b's character-granular span
 * model needs. **The container keeps ONE delegated handler**, as
 * `reader-text.tsx` does today, because a pasted passage is hundreds of
 * characters and a handler per character is hundreds of closures per recolour.
 *
 * **`rt { user-select: none }`** so a copy excludes the pinyin — the rule
 * lives in `ruby.css` with the rest of the styling. AUDIT 1 sources the
 * behaviour for WebKit only (Safari 16.4, bug 80159) and no audit establishes
 * Blink's, so C3 asked for it to be measured: `tests/e2e/core/ruby.spec.ts`
 * found that **Chromium excludes it too** and asserts it, which is what C3
 * instructs in that case. C5b makes the question moot for the reader anyway by
 * taking the clipboard over explicitly.
 *
 * **Pinyin visibility** is `SettingsRow.pinyinDisplay`, three states, default
 * `'always'`. `'never'` hides every `<rt>` **except** on a practice card's
 * answer side, which is what the `force` prop is for. The mirror of `force` is
 * `display="never"`, which the **question** side of a practice card passes:
 * the setting governs reading surfaces, not the side of a card whose whole job
 * is to withhold the answer. See `review-card.tsx`. `'tap'` is the one with a
 * collision in it and C3 resolves it: a tap on a word **reveals that word's
 * readings and opens the sheet in the same gesture**. Concretely —
 *
 *   - default state: no `<rt>` is rendered anywhere and **the ruby band is not
 *     reserved**, so revealing shifts nothing;
 *   - one tap on a word: the sheet opens (rule 2, unchanged) *and* that word's
 *     characters gain their `<rt>`, persisted for the life of the rendered
 *     passage, not to the database;
 *   - a second tap on a character inside it: the character sheet opens; the
 *     reveal has already happened and does not re-fire;
 *   - nothing dismisses a reveal. The set clears when the passage unmounts. A
 *     learner who wants pinyin gone has the `'never'` setting.
 *
 * Layout-shift-free reveal is what makes this cheap: `mode` and the aligned
 * syllables are computed once, so revealing is a class toggle on an
 * already-rendered `<ruby>`, not a re-render.
 */
import { memo, useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';

import { usePinyinDisplay } from '@/components/hanzi/pinyin-display';
import { speakOneCharacter, useSpeakingOffset } from '@/components/hanzi/speak-control';
import { spanIndexOfEvent, type SpanSelect } from '@/components/hanzi/use-span-select';
import { alignReading, type Alignment } from '@/lib/hanzi/align';
import { cn } from '@/lib/cn';
import type { PinyinDisplay } from '@/lib/db/schema';
import type { TTSProvider } from '@/lib/tts/provider';
import type { WordState } from '@/lib/srs/states';

/** One word-sized run: the text, its reading, and what the learner knows. */
export interface HanziRun {
  /** The characters. One `<ruby>` per code point. */
  text: string;
  /**
   * CC-CEDICT numbered pinyin for `text`, when the dictionary has one. Absent
   * means "not a word the dictionary knows" — punctuation, a Latin run, or an
   * unsegmented fragment — and such a run renders plain and untappable.
   */
  pinyinNum?: string;
  /** Word-level marked reading, when the caller already has one. */
  pinyinMarked?: string;
  /**
   * Force this run to be a word: tappable, stateful, part of the token
   * grouping, whatever the dictionary knows about its reading.
   *
   * **The reader needs it and nothing else does** (C5b). A `word` token whose
   * `via` is `'fallback'` — a name, a rare character, an unsegmented fragment —
   * has no headword and therefore no `pinyinNum`, and `lib/reader/states.ts`
   * still answers `'new'` for it because it is a word the learner has
   * demonstrably not met. Inferring tappability from "has a reading" would make
   * exactly those runs plain and untappable, which is a capability the reader
   * has today and must not lose to the rewrite.
   */
  word?: boolean;
}

export interface HanziTextProps {
  /**
   * The runs, in order. A plain string is the common case and
   * `<HanziText text="打算" pinyinNum="da3 suan4" />` is the shorthand for it.
   */
  runs: readonly HanziRun[];
  /**
   * One state per run, aligned by index — exactly the shape
   * `lib/reader/states.ts`'s `tokenStates()` already returns, `undefined` for
   * runs that are not words. Rendered as `data-state` on the **word grouping**,
   * never per character: a word has one state and a character inside it does
   * not have its own.
   */
  states?: readonly (WordState | undefined)[];
  /**
   * Overrides the learner's setting. Omitted — which is every call site except
   * the gallery — it comes from `PinyinDisplayProvider`, defaulting to
   * `'always'` (product-decisions §4 rule 1).
   */
  display?: PinyinDisplay;
  /**
   * Show every reading whatever `display` says. The practice card's **answer**
   * face sets this: the product never hides pinyin there.
   */
  force?: boolean;
  /** A tap on a word grouping. The index is into `runs`. */
  onWord?: (index: number) => void;
  /** A tap on a single character. Indexes are into `runs` and into its code points. */
  onCharacter?: (run: number, char: number) => void;
  className?: string;
  /** Extra classes for the ruby text, e.g. a smaller scale on a card. */
  rtClassName?: string;
  /**
   * `data-testid` for the plain (unreadable, untappable) runs. The reader
   * passes `"reader-text-run"`, which is the hook `tests/e2e/p5/helpers.ts`
   * already reads; everywhere else there is nothing to select and a shared id
   * would be a collision rather than a hook.
   */
  plainRunTestId?: string;
  /**
   * `data-testid` for the word groupings. Defaults to `"hanzi-word"`, and
   * **the reader is the only caller that should override it**, to
   * `"reader-token"` when C5b switches `reader-text.tsx`.
   *
   * It defaulted to `"reader-token"` at first, which quietly made every
   * classifier, every search-result headword and every card face a "reader
   * token" — and `tests/e2e/p5/helpers.ts` counts `reader-token` elements on
   * `/read` to assert how a passage segmented. Since C3 the reader panel
   * contains `<HanziWord>` groupings too, so those counts were about to start
   * measuring the panel as well as the passage.
   */
  wordTestId?: string;
  /**
   * The span to ring, in **base-character offsets over the concatenated run
   * text** — the same index space `useSpanSelect` reports in, because the
   * concatenated run text is exactly the text it maps.
   *
   * Inclusive at both ends. Every word grouping the span overlaps carries
   * `data-in-span` and the ring, which is how "the tapped word stays ringed
   * while the sheet is open" survives the rewrite **and** how the ring follows
   * a whole dragged span rather than only its first word. The exact characters
   * are painted by the Custom Highlight API; the ring is the coarse, always-
   * available half of the same answer, and it is what a spec can assert.
   */
  span?: { from: number; to: number } | null;
  /**
   * The drag-to-select handle (C5b). Given one, this component becomes the
   * span's container: it takes the hook's `ref` and pointer handlers, renders
   * its root as a **block** (`touch-action` does not apply to a non-replaced
   * inline element), and routes the two-tap degrade's closing tap.
   *
   * The **owner** holds the selection and passes it back as `span`; this
   * component never decides what is selected.
   */
  spanSelect?: SpanSelect;
  /**
   * A tap on a character reads that syllable aloud (product-decisions §4 rule
   * 3's third clause; docs/plans/core.md C6).
   *
   * Opt-in, because the two surfaces that already answer a character tap answer
   * it better: the reader and the word sheet open the **character sheet**,
   * which has a speaker of its own and a decomposition besides. It is set where
   * a block speaker sits next to the text and a character tap would otherwise
   * do nothing — a card face, a headword row.
   */
  speakOnTap?: boolean;
  /**
   * The provider `speakOnTap` speaks through. Omitted — which is every call
   * site — it is the Web Speech adapter. Injected by the gallery, which has no
   * voices to speak with, and by the unit suite.
   */
  speakProvider?: TTSProvider;
  'data-testid'?: string;
}

/** The colouring, carried across from `reader-text.tsx` unchanged in meaning. */
const STATE_CLASS: Record<WordState, string> = {
  known: 'token-known',
  learning: 'token-learning rounded bg-lookup-soft text-lookup',
  new: 'token-new rounded underline decoration-new decoration-dotted decoration-2 underline-offset-4',
};

/**
 * The class that marks the character being read aloud (docs/plans/core.md C6).
 *
 * **A class on the character, not a second Custom Highlight.** C6 asks for the
 * Custom Highlight API "with a different highlight name, so the 'currently
 * speaking' mark and the 'selected span' mark compose instead of fighting", and
 * the requirement there is the *composition*, which this satisfies: a class on
 * the element and a `::highlight()` on ranges are different mechanisms and both
 * apply, which `tests/unit/hanzi/speak-control.test.tsx` asserts on one
 * character. What the Highlight API buys is no DOM mutation per **pointer
 * move** — the reason C5a chose it for a drag — and a sequence changes one
 * character per utterance, roughly once a second. Buying it here would mean
 * building a character map inside every card face and every headword row that
 * might ever speak, which is real cost for nothing. Recorded in HANDOFF.md as
 * a deviation from C6's stated mechanism, with this reason.
 *
 * It is **neutral**, not one of the three accents: §1 assigns vermillion to
 * Practice and the single primary action, jade to Look up and "learning", gold
 * to "new", and a speaking mark that borrowed any of them would read as a word
 * state the learner had earned.
 */
const SPEAKING_CLASS = 'char-speaking';

interface RunView {
  run: HanziRun;
  alignment: Alignment;
  tappable: boolean;
  /** Offset of this run's first character in the concatenated base text. */
  start: number;
  /** One past its last. See `HanziTextProps.span`. */
  end: number;
}

/**
 * Each of a run's characters with its **code-unit** offset in the whole block.
 *
 * `lib/tts/sequence.ts` counts code points and `SpeakControl` converts; the DOM
 * and `data-hanzi` count code units, and this is the other half of that
 * conversion. Aligned and fallback runs share it so a block cannot light one
 * character in one branch and another in the other.
 */
function offsetsOf(view: RunView): { char: string; offset: number }[] {
  const out: { char: string; offset: number }[] = [];
  let at = view.start;
  const chars =
    view.alignment.mode === 'aligned'
      ? view.alignment.chars.map((aligned) => aligned.char)
      : [...view.run.text];
  for (const char of chars) {
    out.push({ char, offset: at });
    at += char.length;
  }
  return out;
}

function viewOf(run: HanziRun, start: number): RunView {
  const alignment = run.pinyinNum
    ? alignReading(run.text, run.pinyinNum)
    : {
        chars: [...run.text].map((char) => ({ char })),
        mode: 'fallback' as const,
        // A caller with only the marked word-level form — an example-sentence
        // token, whose reading the model returned already marked — still gets
        // one annotation over the run. It is not per character, because
        // `alignReading` needs the NUMBERED form, and guessing the split from
        // marked text is the silent error R5 is about.
        reading: run.pinyinMarked ?? '',
      };
  // "Is this a word the dictionary knows?" — which is what makes it annotatable
  // AND tappable. A run with neither form of reading is punctuation, a Latin
  // run, or an unsegmented fragment: plain, and not a tap target.
  return {
    run,
    alignment,
    tappable: run.word ?? Boolean(run.pinyinNum ?? run.pinyinMarked),
    start,
    end: start + run.text.length,
  };
}

function Ruby({
  char,
  syllable,
  revealed,
  speaking,
  runIndex,
  charIndex,
  rtClassName,
}: {
  char: string;
  syllable: string | undefined;
  revealed: boolean;
  /** This character is the one the hold-to-slow sequence is reading (C6). */
  speaking: boolean;
  runIndex: number;
  charIndex: number;
  rtClassName?: string;
}) {
  // No `<rt>` at all when there is nothing to show. An empty one reserves the
  // ruby band and teaches nothing (C3, the `xx5` rule).
  const annotation = revealed && syllable ? syllable : undefined;
  return (
    <ruby
      data-testid="hanzi-char"
      data-char-index={charIndex}
      data-run-index={runIndex}
      {...(speaking ? { 'data-speaking': 'true' } : {})}
      className={cn('hanzi-ruby', speaking && SPEAKING_CLASS)}
    >
      {char}
      {annotation === undefined ? null : (
        <>
          {/*
            `<rp>` is not decoration and not a legacy fallback here: it is what
            keeps the ACCESSIBLE NAME readable. A `<ruby>` with no `<rp>`
            computes its name from the interleaved text, so the review card's
            `<h2>` read back as "打dǎ算suàn" — the same interleaving that broke
            fifteen e2e specs, except that the sighted surface was fixed with
            `data-hanzi` and the assistive one was not. With the parentheses a
            reader that does not understand ruby says "打 (dǎ) 算 (suàn)", and
            one that does ignores them. They are `user-select: none` alongside
            the `<rt>`, so a copy still yields the bare hanzi.
          */}
          <rp>(</rp>
          <rt data-testid="hanzi-rt" className={rtClassName}>
            {annotation}
          </rt>
          <rp>)</rp>
        </>
      )}
    </ruby>
  );
}

const Runs = memo(function Runs({
  views,
  states,
  revealedRuns,
  showAll,
  rtClassName,
  plainRunTestId,
  wordTestId,
  span,
  interactive,
  speakingOffset,
}: {
  views: readonly RunView[];
  states: readonly (WordState | undefined)[] | undefined;
  revealedRuns: ReadonlySet<number>;
  showAll: boolean;
  rtClassName?: string;
  plainRunTestId?: string;
  wordTestId: string;
  span: { from: number; to: number } | null | undefined;
  /**
   * The runs answer a tap, so each word grouping is a real control.
   *
   * **`<button>`, not a `<span>` with a click handler**, and that is a
   * restoration rather than a choice: the `reader-text.tsx` C5b deleted said in
   * its own header "Word tokens are real `<button>`s, so Tab and Enter reach
   * them for free and the delegated handler sees the Enter as a click", and the
   * first draft of the replacement dropped it — measured afterwards as zero
   * focusable elements inside the passage, so a keyboard or switch user could
   * not look up a single word, could not reach "Mark known", and could arm the
   * two-tap degrade with no way to close it. It costs one tab stop per word,
   * which is exactly what the reader had before.
   *
   * Off for the thirty non-interactive call sites — a card face, a search
   * result, a list row — where a button per word would add tab stops to
   * something nobody can do anything with.
   */
  interactive: boolean;
  /**
   * Code-unit offset of the character being spoken inside this block, or
   * `null`. Published by `SpeakControl` while the hold-to-slow sequence runs.
   */
  speakingOffset: number | null;
}) {
  return (
    <>
      {views.map((view, index) => {
        const state = states?.[index];
        const revealed = showAll || revealedRuns.has(index);
        // A run the dictionary has no reading for renders plain: no ruby, no
        // state, not a tap target. `data-testid="reader-text-run"` is the hook
        // `tests/e2e/p5` already reads, and it survives verbatim.
        if (!view.tappable) {
          return (
            <span key={index} {...(plainRunTestId ? { 'data-testid': plainRunTestId } : {})}>
              {view.run.text}
            </span>
          );
        }
        const wordLevel = view.alignment.mode === 'fallback';
        // Overlap, not containment: a dragged span can start or end inside a
        // word, and the ring is the coarse answer to "what did I select".
        const inSpan =
          span !== null && span !== undefined && view.start <= span.to && view.end > span.from;
        const Word = interactive ? 'button' : 'span';
        return (
          <Word
            key={index}
            {...(interactive ? ({ type: 'button' } as const) : {})}
            data-testid={wordTestId}
            data-token-index={index}
            data-token={view.run.text}
            data-state={state ?? 'unknown'}
            data-align={view.alignment.mode}
            {...(inSpan ? { 'data-in-span': 'true' } : {})}
            className={cn(
              'hanzi-token cursor-pointer align-baseline transition-colors',
              // A `<button>` brings its own box; these are what `reader-text.tsx`
              // used to keep a word sitting in the line like the text it is.
              interactive && 'px-0 font-[inherit] leading-[inherit]',
              state ? STATE_CLASS[state] : undefined,
              // Vermillion, not jade: the reader already tints a word in
              // *learning* jade, and a ring in the same colour would read as a
              // word state the learner has earned rather than a selection they
              // just made. It matches `::highlight(span-select)` next door.
              inSpan && 'rounded-[var(--r-sm)] ring-2 ring-practice ring-offset-1 ring-offset-surface',
            )}
          >
            {wordLevel ? (
              // One annotation over the whole run, or none at all when the
              // dictionary has no reading. Never a per-character guess.
              <ruby data-testid="hanzi-char" data-run-index={index}>
                {/*
                  One annotation, but still one `data-char-index` PER
                  CHARACTER. The index used to be a hardcoded 0 on the whole
                  run, so a tap anywhere inside AA制 — or any `xx5` entry, or
                  any example-sentence token, all of which take this branch —
                  reported character 0, and C4's character sheet would have
                  opened on the wrong character with no signal that it had.
                  What fallback means is that the READING cannot be split, not
                  that the characters cannot be counted.
                */}
                {offsetsOf(view).map(({ char, offset }, charIndex) => (
                  <span
                    key={charIndex}
                    data-char-index={charIndex}
                    {...(offset === speakingOffset ? { 'data-speaking': 'true' } : {})}
                    className={offset === speakingOffset ? SPEAKING_CLASS : undefined}
                  >
                    {char}
                  </span>
                ))}
                {revealed && view.alignment.reading ? (
                  <>
                    <rp>(</rp>
                    <rt data-testid="hanzi-rt" className={rtClassName}>
                      {view.alignment.reading}
                    </rt>
                    <rp>)</rp>
                  </>
                ) : null}
              </ruby>
            ) : (
              view.alignment.chars.map((aligned, charIndex) => (
                <Ruby
                  key={charIndex}
                  char={aligned.char}
                  syllable={aligned.syllable}
                  speaking={offsetsOf(view)[charIndex]?.offset === speakingOffset}
                  revealed={revealed}
                  runIndex={index}
                  charIndex={charIndex}
                  {...(rtClassName === undefined ? {} : { rtClassName })}
                />
              ))
            )}
          </Word>
        );
      })}
    </>
  );
});

export function HanziText({
  runs,
  states,
  display,
  force = false,
  onWord,
  onCharacter,
  className,
  rtClassName,
  plainRunTestId,
  wordTestId = 'hanzi-word',
  span = null,
  spanSelect,
  speakOnTap = false,
  speakProvider,
  'data-testid': testId = 'hanzi-text',
}: HanziTextProps) {
  const views = useMemo(() => {
    let at = 0;
    return runs.map((run) => {
      const view = viewOf(run, at);
      at = view.end;
      return view;
    });
  }, [runs]);
  const [revealedRuns, setRevealedRuns] = useState<ReadonlySet<number>>(() => new Set<number>());
  const setting = usePinyinDisplay();
  const effective = display ?? setting;
  /**
   * Which character this block is currently reading aloud, if any (C6).
   *
   * Keyed on the block's own base text — the same string `data-hanzi` carries —
   * because the speaker is a sibling, not a parent. One subscription per
   * rendered block, and it answers `null` for every block while nothing speaks.
   */
  const blockText = useMemo(() => runs.map((run) => run.text).join(''), [runs]);
  const speakingOffset = useSpeakingOffset(blockText);

  const showAll = force || effective === 'always';
  const revealsOnTap = !force && effective === 'tap';

  /**
   * A change of passage clears the reveals.
   *
   * `revealedRuns` holds **indexes into `runs`**, and React reuses a component
   * instance whenever the element type and position are stable — a reader
   * swapping texts, a sheet showing a second entry, `<HanziWord>` re-rendered
   * with new `text`. Without this, run 3 of the new passage came up already
   * revealed because run 3 of the old one had been tapped, and the word the
   * learner actually tapped did not. The header's "the set clears when the
   * passage unmounts" was only true when a new passage *was* an unmount.
   */
  useEffect(() => {
    setRevealedRuns((previous) => (previous.size === 0 ? previous : new Set<number>()));
  }, [runs]);
  /**
   * Reserved only when something in the passage **actually renders an
   * annotation** — not merely when the setting would allow one. A passage of
   * entries the dictionary has no reading for (`xx5`), or of punctuation, has
   * nothing above the line and must not carry an empty band; `'always'` alone
   * is not evidence that anything will be drawn.
   */
  const bandReserved = useMemo(() => {
    const annotatable = (view: RunView) =>
      view.alignment.mode === 'aligned'
        ? view.alignment.chars.some((char) => Boolean(char.syllable))
        : Boolean(view.alignment.reading);
    /**
     * In `'tap'` the band is reserved **from the first render**, before
     * anything is revealed.
     *
     * core.md C3 asks for two things that cannot both hold: "the ruby band is
     * **not** reserved" in the default state, and "no layout shift on reveal —
     * this is why it must be specified now: reserving the band changes the line
     * box". Reserving it later *is* the shift. The stated reason wins over the
     * stated mechanism: a learner who chose "only when I tap" is going to tap,
     * and a passage that jumps a line every time they do is the failure the
     * criterion names. Recorded in HANDOFF.md as a contradiction in the plan.
     *
     * `'never'` reserves nothing, and `'always'`/`force` reserve only when
     * something is actually drawn — a passage of `xx5` entries or of
     * punctuation has nothing above the line and must not carry an empty band.
     */
    if (revealsOnTap) return views.some(annotatable);
    return views.some((view, index) => (showAll || revealedRuns.has(index)) && annotatable(view));
  }, [revealedRuns, revealsOnTap, showAll, views]);

  const onClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const target = event.target as HTMLElement | null;
      /**
       * **The degrade's closing tap comes first, and it is not a word tap.**
       *
       * With no caret API there is no `pointermove` path at all, so the span is
       * made by two taps: the owner arms an anchor ("…to here"), and the next
       * tap anywhere on the text closes it. Opening the word sheet on the same
       * tap would answer a question the learner did not ask — they asked for
       * the span, which is what `onCommit` delivers.
       */
      if (spanSelect && spanSelect.anchor !== null) {
        // `'last'`: a keyboard activation names the word, not a character, and
        // "…to here" on a word means the whole word rather than its first
        // character. A pointer tap names a character and this does not apply.
        const at = spanIndexOfEvent(target, 'last');
        if (at !== undefined) {
          spanSelect.toHere(at);
          return;
        }
      }
      // …and the *arming* tap, for the consumer that asked for one (the C5a
      // harness). The reader does not: its first tap opens the word sheet.
      if (spanSelect?.armsOnTap && spanSelect.api === 'none') {
        const at = spanIndexOfEvent(target);
        if (at !== undefined) {
          spanSelect.armFromTap(at);
          return;
        }
      }
      const ruby = target?.closest<HTMLElement>('[data-char-index]');
      const token = target?.closest<HTMLElement>('[data-token-index]');
      if (!token) return;
      const runIndex = Number(token.getAttribute('data-token-index'));
      if (Number.isNaN(runIndex)) return;

      if (revealsOnTap && !revealedRuns.has(runIndex)) {
        // One gesture, two effects: the reading appears AND the sheet opens.
        setRevealedRuns((previous) => new Set(previous).add(runIndex));
      }

      // A character tap only means "character" once the word is already open —
      // which is the caller's business, so both are reported and the caller
      // decides. `onWord` always fires; `onCharacter` fires alongside it when
      // the tap landed on an identifiable character.
      onWord?.(runIndex);
      if (ruby) {
        const charIndex = Number(ruby.getAttribute('data-char-index'));
        if (!Number.isNaN(charIndex)) {
          onCharacter?.(runIndex, charIndex);
          /**
           * Rule 3's third clause: a tap on a character reads that syllable
           * alone. Only where the caller asked for it — the surfaces that
           * answer a character tap with the character *sheet* are answering a
           * bigger question and this would talk over it.
           */
          if (speakOnTap && !onCharacter) {
            const char = offsetsOf(views[runIndex])[charIndex]?.char;
            if (char) speakOneCharacter(char, speakProvider);
          }
        }
      }
    },
    [onCharacter, onWord, revealedRuns, revealsOnTap, spanSelect, speakOnTap, speakProvider, views],
  );

  /**
   * A **block** when a span handle is attached, an inline `<span>` otherwise.
   *
   * `touch-action` does not apply to a non-replaced inline element, so
   * `touch-action: pan-y` on an inline root would be silently ignored — and the
   * whole gesture design rests on that declaration being honoured. Every other
   * call site is a headword or a card face sitting inside a sentence, where an
   * inline root is what makes it lay out at all, so this switches rather than
   * settling on one.
   */
  const Root = spanSelect ? 'div' : 'span';

  return (
    <Root
      data-testid={testId}
      data-display={force ? 'forced' : effective}
      /**
       * The base characters, without the readings. `<ruby>` interleaves the
       * `<rt>` into `textContent` — `打dǎ算suàn` — which is correct for the DOM
       * and useless as a hook, so every consumer that wants the string reads
       * this instead of the text. The e2e suite's same-text-at-both-widths
       * check (C7) and every card assertion go through it.
       */
      data-hanzi={runs.map((run) => run.text).join('')}
      data-band={bandReserved ? 'reserved' : 'none'}
      lang="zh-Hans"
      {...(spanSelect ? { ref: spanSelect.ref, ...spanSelect.handlers } : {})}
      /**
       * One delegated handler for the whole passage. See the header.
       *
       * `revealsOnTap` is in the condition because the reveal lives in this
       * handler: attached only when a caller supplied a callback, `'tap'` was
       * dead everywhere in the app. The gallery was the single call site that
       * passed `onWord`, and it passes `() => undefined` precisely so the state
       * can be demonstrated — so "only when I tap" behaved exactly like
       * "never" on every card, every search result and every list row.
       *
       * `spanSelect` joins them because the two-tap degrade's closing tap
       * arrives here and nowhere else.
       */
      onClick={
        onWord || onCharacter || revealsOnTap || spanSelect || speakOnTap ? onClick : undefined
      }
      className={cn(
        'hanzi',
        bandReserved && 'hanzi-band',
        // `user-select: none` + the iOS callout suppression, on the container
        // the gesture runs over. See `app/globals.css`'s `.hanzi-span-host`: the
        // reader went without it and the whole clipboard criterion was false.
        spanSelect && 'hanzi-span-host',
        className,
      )}
    >
      <Runs
        views={views}
        states={states}
        revealedRuns={revealedRuns}
        showAll={showAll}
        wordTestId={wordTestId}
        span={span}
        interactive={Boolean(onWord || onCharacter)}
        speakingOffset={speakingOffset}
        {...(rtClassName === undefined ? {} : { rtClassName })}
        {...(plainRunTestId === undefined ? {} : { plainRunTestId })}
      />
    </Root>
  );
}

/** The one-run shorthand, which is most call sites. */
export function HanziWord({
  text,
  pinyinNum,
  pinyinMarked,
  ...rest
}: Omit<HanziTextProps, 'runs' | 'states'> & HanziRun) {
  const runs = useMemo(
    () => [
      {
        text,
        ...(pinyinNum === undefined ? {} : { pinyinNum }),
        ...(pinyinMarked === undefined ? {} : { pinyinMarked }),
      },
    ],
    [pinyinMarked, pinyinNum, text],
  );
  return <HanziText runs={runs} {...rest} />;
}
