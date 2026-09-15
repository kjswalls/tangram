/**
 * The text-to-speech seam (PLAN.md §3.6; widened by docs/plans/core.md C2).
 *
 * Speech is a browser capability, not a dependency: the app asks an interface
 * whether a Chinese voice exists and, if one does, hands it a string. The
 * interface exists because the answer is environment-dependent and because
 * headless Chromium — the only browser this build can run — ships no voices at
 * all, so every consumer has to render a sane disabled state rather than assume
 * audio.
 *
 * **This is a settle-first shared surface** (docs/STACK.md §7). `ios.md` I4 and
 * `android.md` A4 implement it against `@capacitor-community/text-to-speech`;
 * HANDOFF.md records it verbatim. A change here stops the build and goes into
 * HANDOFF.md (CLAUDE.md, "Shared surfaces").
 *
 * --- What C2 added, and why each thing is here ------------------------------
 *
 * The pre-C2 interface was three members — `name`, `available()`, `speak()` —
 * and `speak` resolved once the utterance was *queued*. Nothing could stop,
 * sequence or track speech, which C6's hold-to-slow mode (one utterance per
 * character, each character lit as it plays) cannot be built on.
 *
 * 1. **`stop()`** — nothing could cancel speech except the implicit cancel
 *    inside the next `speak`.
 * 2. **Utterance identity.** `speak()` returns a handle *synchronously*, so a
 *    per-character sequence started at C6 can be cancelled mid-flight without
 *    cancelling something newer. Synchronously matters: the Web Speech adapter
 *    has to await its voice list before it can speak, and a handle that only
 *    existed after that await would be uncancellable during exactly the window
 *    a second tap arrives in.
 * 3. **An event surface**, per utterance: `start`, `end`, `boundary`, `cancel`,
 *    `error`. `boundary` carries character offsets into the utterance's own
 *    text. The native plugin forwards `onRangeStart`
 *    (`AVSpeechSynthesizer`'s `willSpeakRangeOfSpeechString`; Android's
 *    `UtteranceProgressListener.onRangeStart`, API 26+).
 * 4. **`voices()` and a voice preference**, so tier 2 (a cloud voice) and the
 *    mobile plugin can expose choices without a second interface.
 *
 * --- The boundary fallback, stated in the interface's own documentation -----
 *
 * Two of the three engines cannot be relied on for boundaries: WebKit's Web
 * Speech boundary events are documented unreliable, and `window.speechSynthesis`
 * is reported **undefined** in the Android WebView (STACK register #19 — the
 * issue id came from a search snippet and is a five-second check on a device).
 *
 * The rule, identical on native and web: **when boundary events are absent,
 * drive the highlight off per-character utterance `start`** — one utterance per
 * character. `supportsBoundary` is a **declared capability**, not a `typeof`
 * check, so a consumer branches on what the provider promises rather than on
 * what happens to be defined in this browser. `lib/tts/sequence.ts` goes
 * further and never uses boundaries at all; see its header.
 *
 * --- Two rules an implementer cannot infer, so they are stated -------------
 *
 * **1. `start` is REPLAYED to a late subscriber.** `speak()` returns
 * synchronously and a consumer subscribes on the next statement, so an engine
 * that reports "speaking" from inside `speak()` would lose every `start` and
 * the highlight would never advance. That is not hypothetical:
 * `@capacitor-community/text-to-speech` — the plugin `ios.md` I4 and
 * `android.md` A4 implement against — has **no start event at all**
 * (`speak()` returns a promise that resolves when speech *finishes*, plus
 * `stop()`, the voice/language queries, and an `onRangeStart` listener), so a
 * mobile adapter has to synthesise `start`, and the obvious place to synthesise
 * it is at dispatch. So: **an `Utterance` remembers that `start` fired, and
 * `on('start', …)` invokes a listener immediately if it already has.** Only
 * `start` replays; `boundary` is a stream and `end`/`cancel`/`error` are
 * terminal and observable through `done`.
 *
 * **2. A provider must never read Mandarin text in Cantonese.** This is a
 * product rule, not a web-adapter detail, and it belongs in the frozen surface
 * because the mobile adapters pick their own voices: `zh-HK`, `zh-MO` and
 * `yue*` read hanzi in Cantonese (macOS Sin-ji, Chrome's 粵語（香港）, Windows
 * Tracy). The card shows Mandarin pinyin, so a Cantonese reading of it is a
 * wrong answer the learner cannot detect (PLAN.md §1); silence is better. A
 * conforming provider therefore **refuses** such a voice rather than ranking it
 * last — including when `SpeakOptions.voiceId` names one — and reports
 * `available() === false` on a device whose only Chinese voices are Cantonese.
 * `lib/tts/speech-synthesis.ts` exports `isCantoneseVoice` so an adapter can
 * apply the same predicate rather than re-deriving it.
 */

/**
 * The platform's own identifier for a voice, **as this provider mints it**. It
 * is opaque, only ever compared, and only comparable *within one provider
 * instance*: the Web Speech adapter uses `voiceURI`, and a Capacitor adapter
 * has to mint one because the plugin's own `TTSOptions.voice` is a **number,
 * the index into `getSupportedVoices()`** — an index that is not stable across
 * an OS voice install. An adapter that mints ids owns the id→index map and
 * re-derives it when the voice list changes. A stored preference that no longer
 * resolves must fall back to the provider's own ranking, never to silence.
 */
export type VoiceId = string;

export interface TTSVoice {
  id: VoiceId;
  name: string;
  /** BCP-47, as the engine reports it. */
  lang: string;
  /** The engine marks this the default for its language. */
  isDefault: boolean;
}

export interface SpeakOptions {
  /** BCP-47 tag handed to the utterance; defaults to the chosen voice's own. */
  lang?: string;
  /** 0.1–10, 1 is the browser default. Slower is the point for a learner. */
  rate?: number;
  /**
   * Prefer this voice. An id the provider does not have falls back to its own
   * ranking rather than refusing — a stored preference must not make the app
   * silent after a system update removes a voice.
   */
  voiceId?: VoiceId;
}

/** Where an utterance ended up. `done` resolves to one of these; it never rejects. */
export type UtteranceOutcome = 'ended' | 'cancelled' | 'error' | 'unavailable';

export interface BoundaryEvent {
  /** Code-unit offset into the utterance's own `text`. */
  charIndex: number;
  /** Length of the run being spoken, when the engine reports one. */
  charLength?: number;
}

export interface UtteranceEvents {
  start: undefined;
  end: undefined;
  boundary: BoundaryEvent;
  cancel: undefined;
  error: { message: string };
}

export type UtteranceEventName = keyof UtteranceEvents;

export interface Utterance {
  /** Unique within a provider, and monotonic. Identity, not an index. */
  readonly id: number;
  readonly text: string;
  /**
   * Resolves once the utterance has ended, been cancelled, errored, or been
   * refused because no voice exists. **Never rejects** — a provider that cannot
   * speak returns quietly rather than throwing into a click handler.
   *
   * **And it must EVENTUALLY settle.** That is a requirement on the adapter,
   * not a hope about the engine: consumers await it with no timeout of their
   * own (`lib/tts/sequence.ts` awaits one per character), so a `done` that
   * never resolves hangs the caller with a character lit and no way out but
   * `stop()`. The engines drop utterances — Chrome cuts a long one without an
   * `end`, and iOS drops the completion callback when the app backgrounds
   * mid-utterance — so an adapter owns a watchdog of its own. The Web Speech
   * adapter's is `speech-synthesis.ts`'s `#watchdogMs`.
   */
  readonly done: Promise<UtteranceOutcome>;
  /**
   * Returns an unsubscribe function.
   *
   * **`start` replays**: subscribing after the utterance has already started
   * invokes the listener immediately. See the header — without this rule a
   * consumer that subscribes on the statement after `speak()` is racing the
   * provider, and on an engine with no start event of its own it always loses.
   */
  on<K extends UtteranceEventName>(
    event: K,
    listener: (payload: UtteranceEvents[K]) => void,
  ): () => void;
  /**
   * Cancel this utterance and nothing else. A no-op once it has finished, so a
   * consumer that cancels an old sequence cannot silence a newer one.
   */
  cancel(): void;
}

export interface TTSProvider {
  readonly name: string;
  /**
   * Whether `boundary` events can be relied on. **Declared, not detected** —
   * see the header. A consumer that needs per-character progress must work
   * with this `false`, because on two of the three engines it is.
   */
  readonly supportsBoundary: boolean;
  /**
   * Whether this provider can speak **Mandarin** in this environment, right
   * now. A device whose only Chinese voices are Cantonese answers `false` —
   * see rule 2 in the header.
   */
  available(): Promise<boolean>;
  /** Every voice the engine admits to, Chinese or not. May be empty. */
  voices(): Promise<readonly TTSVoice[]>;
  /**
   * Queue `text` and return its handle **synchronously**. An empty or
   * whitespace-only string still returns a handle, already resolved
   * `'unavailable'`, so a caller never has to special-case it.
   */
  speak(text: string, opts?: SpeakOptions): Utterance;
  /** Cancel everything this provider has queued or is speaking. */
  stop(): void;
  /**
   * Subscribe to "the set of voices may have changed"; returns an unsubscribe.
   *
   * `available()` is a question with a **different answer at different times**,
   * and a consumer that asks it once on mount gets it wrong. Chrome's voice
   * list is empty on a cold navigation and populates asynchronously — on Linux
   * (speech-dispatcher) well past any timeout worth waiting through — so every
   * speaker mounted before it lands said "No voice" for the life of the mount
   * while a speaker mounted afterwards worked. Two identical buttons on one
   * screen, disagreeing. On mobile the same event is an OS voice install or
   * removal, which is also when a stored `SpeakOptions.voiceId` stops
   * resolving.
   *
   * An adapter with no such signal returns a no-op unsubscribe and never
   * calls the listener — which is honest, and leaves the consumer's first
   * answer standing rather than making it re-poll.
   */
  onVoicesChanged(listener: () => void): () => void;
}
