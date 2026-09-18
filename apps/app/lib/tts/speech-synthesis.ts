/**
 * `TTSProvider` over the Web Speech API (PLAN.md §3.6; widened at core.md C2).
 *
 * Four things here are load-bearing. The first three predate C2 and are
 * unchanged; the fourth is what C2 replaced.
 *
 * 1. **`available()` waits for `voiceschanged`, but not forever.** Chrome
 *    returns an empty list from the first `getVoices()` and fires
 *    `voiceschanged` once the list is populated; Safari populates
 *    synchronously; headless Chromium never fires at all because it has no
 *    voices. So: ask once, and if the list is empty wait for the event with a
 *    500 ms timeout and answer with whatever is there when the timer wins.
 * 2. **A `zh*` voice is the requirement**, not a `zh-CN` one — but Mandarin
 *    ones are ranked and Cantonese ones are refused. `zh-TW`, `cmn-Hans-CN`
 *    and bare `zh` all read hanzi in Mandarin, and matching the exact tag would
 *    report "no voice" on a machine that has three. `zh-HK` / `zh-MO` / `yue*`
 *    also read hanzi — in **Cantonese** (macOS Sin-ji, Chrome's 粵語（香港）,
 *    Windows Tracy). The card shows Mandarin pinyin, so a Cantonese reading of
 *    it is a wrong answer the learner cannot detect (§1); silence is better.
 * 2b. **Voices are ranked, not filtered-then-first.** `default` is the OS UI
 *    voice and is essentially never Chinese, so "first Chinese voice" meant
 *    "whatever the platform happened to list first" — on a Mac with Sin-ji and
 *    Ting-Ting installed, that is Sin-ji.
 * 3. **One utterance in the engine at a time.** The browser's own queue is
 *    global and additive, and `cancel()` empties all of it — so an app that
 *    hands the engine five utterances cannot cancel the fourth without killing
 *    the first three. This adapter keeps its own queue, hands the engine
 *    exactly one utterance, and advances on `end`.
 *
 * --- What C2 changed about `speak()`, and why -------------------------------
 *
 * **`speak()` now ENQUEUES; it no longer cancels what is already speaking.**
 * Before C2 it called `synth.cancel()` first, because "tapping the speaker
 * twice without a cancel plays the word twice, back to back, which is the
 * single most annoying thing a review card can do". That is still true and it
 * is still prevented — one layer up. C6's hold-to-slow mode is *N utterances,
 * one per character, in order*, which an interface that cancels on every
 * `speak` cannot express at all; so the queue moved here and the decision moved
 * to the consumer. `SpeakButton` calls `stop()` before it speaks, and its unit
 * test asserts a double tap plays once.
 *
 * `speak()` returns its handle **synchronously** even though the voice list may
 * not have resolved yet. That window — first call, Chrome, voices still
 * loading — is exactly when a second tap arrives, and a handle that did not
 * exist yet would be uncancellable.
 *
 * **`supportsBoundary` is `false` here, deliberately.** Chrome desktop does
 * fire `boundary`, but WebKit's are documented unreliable and the Android
 * WebView may have no `speechSynthesis` at all (STACK register #19). The flag
 * is a *promise to consumers*, not a feature detect, and this adapter does not
 * make a promise it cannot keep on every engine it runs in. `boundary` events
 * are still forwarded when the engine emits them; a consumer may use them
 * opportunistically, but nothing may depend on them.
 */

import type {
  SpeakOptions,
  TTSProvider,
  TTSVoice,
  Utterance,
  UtteranceEventName,
  UtteranceEvents,
  UtteranceOutcome,
} from '@/lib/tts/provider';

/** How long to wait for `voiceschanged` before answering with what we have. */
export const VOICES_TIMEOUT_MS = 500;

const DEFAULT_LANG = 'zh-CN';

function normalise(voice: Pick<SpeechSynthesisVoice, 'lang'>): string {
  return (voice.lang ?? '').toLowerCase().replace(/_/g, '-');
}

/** `zh`, `zh-CN`, `zh_TW`, `zh-HK`, `cmn-Hans-CN` — anything that reads hanzi. */
export function isChineseVoice(voice: Pick<SpeechSynthesisVoice, 'lang'>): boolean {
  const lang = normalise(voice);
  return (
    lang === 'zh' ||
    lang.startsWith('zh-') ||
    lang === 'cmn' ||
    lang.startsWith('cmn-') ||
    lang === 'yue' ||
    lang.startsWith('yue-')
  );
}

/**
 * Reads hanzi, in Cantonese: `yue*`, and the two `zh-*` regions whose system
 * voices are Cantonese everywhere (Hong Kong, Macau). These are refused, not
 * ranked last — see the header.
 */
export function isCantoneseVoice(voice: Pick<SpeechSynthesisVoice, 'lang'>): boolean {
  const lang = normalise(voice);
  return (
    lang === 'yue' ||
    lang.startsWith('yue-') ||
    lang === 'zh-hk' ||
    lang === 'zh-mo' ||
    lang.startsWith('zh-hk-') ||
    lang.startsWith('zh-mo-') ||
    lang.includes('-yue')
  );
}

/**
 * Lower is better. 0 mainland/Singapore Mandarin, 1 Taiwan Mandarin, 2 an
 * unqualified `zh`/`cmn`. Cantonese scores `null` and never speaks.
 */
function rank(voice: Pick<SpeechSynthesisVoice, 'lang'>): number | null {
  if (!isChineseVoice(voice) || isCantoneseVoice(voice)) return null;
  const lang = normalise(voice);
  if (lang.startsWith('zh-cn') || lang.startsWith('zh-sg') || lang.includes('hans')) return 0;
  if (lang.startsWith('zh-tw') || lang.includes('hant')) return 1;
  return 2;
}

/**
 * The best Mandarin voice in the list: by tier, then by the browser's own
 * `default` flag as a tiebreak *within* a tier, then by list order. Null when
 * the browser has no Mandarin voice — including the case where it has only a
 * Cantonese one.
 */
export function pickChineseVoice(
  voices: readonly SpeechSynthesisVoice[],
): SpeechSynthesisVoice | null {
  let best: SpeechSynthesisVoice | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const voice of voices) {
    const tier = rank(voice);
    if (tier === null) continue;
    if (tier < bestRank) {
      best = voice;
      bestRank = tier;
      continue;
    }
    // Same tier: the browser's default wins over list order, once.
    if (tier === bestRank && voice.default && !best?.default) best = voice;
  }
  return best;
}

/** The engine's identifier, which is what `SpeakOptions.voiceId` names. */
function idOf(voice: Pick<SpeechSynthesisVoice, 'voiceURI' | 'name'>): string {
  return voice.voiceURI || voice.name;
}

// ---------------------------------------------------------------------------
// The handle

type Listeners = {
  [K in UtteranceEventName]: Set<(payload: UtteranceEvents[K]) => void>;
};

class Handle implements Utterance {
  readonly id: number;
  readonly text: string;
  readonly done: Promise<UtteranceOutcome>;
  /**
   * The options THIS utterance was queued with. They live on the handle, not on
   * the pump: `#pump` is re-entered by whichever utterance happened to finish,
   * so a pump parameter applied the previous call's rate, voice and lang to the
   * next one in the queue — silently, because both current callers keep the
   * queue at depth one. C6 interleaves 0.6x per-character utterances with the
   * 0.9x block speaker on this same provider, which is where it would have been
   * audible.
   */
  readonly opts: SpeakOptions;

  #settle!: (outcome: UtteranceOutcome) => void;
  #settled = false;
  readonly #listeners: Listeners = {
    start: new Set(),
    end: new Set(),
    boundary: new Set(),
    cancel: new Set(),
    error: new Set(),
  };

  /** Set by the provider while this handle is the one in the engine. */
  live: SpeechSynthesisUtterance | null = null;
  cancelled = false;
  started = false;

  constructor(
    id: number,
    text: string,
    opts: SpeakOptions,
    /** The provider's one cancel path. See the note on `cancel()`. */
    private readonly onCancel: (handle: Handle) => void,
  ) {
    this.id = id;
    this.text = text;
    this.opts = opts;
    this.done = new Promise((resolve) => {
      this.#settle = resolve;
    });
  }

  on<K extends UtteranceEventName>(
    event: K,
    listener: (payload: UtteranceEvents[K]) => void,
  ): () => void {
    // `start` replays — the interface's rule 1. A consumer subscribes on the
    // statement after `speak()`, and an engine that reports "speaking" from
    // inside `speak()` would otherwise lose it every time.
    if (event === 'start' && this.started) {
      (listener as (payload: UtteranceEvents['start']) => void)(undefined);
    }
    this.#listeners[event].add(listener);
    return () => {
      this.#listeners[event].delete(listener);
    };
  }

  emit<K extends UtteranceEventName>(event: K, payload: UtteranceEvents[K]): void {
    // A copy, because a listener that unsubscribes itself would otherwise
    // mutate the set being iterated.
    for (const listener of [...this.#listeners[event]]) listener(payload);
  }

  /** Idempotent: the engine fires `end` after a `cancel` on some platforms. */
  settle(outcome: UtteranceOutcome): void {
    if (this.#settled) return;
    this.#settled = true;
    this.live = null;
    this.#settle(outcome);
  }

  get isSettled(): boolean {
    return this.#settled;
  }

  /**
   * One cancel path, and it is the provider's — it has to drop the handle from
   * the queue, cancel the engine if this is the one speaking, and pump the
   * next. An earlier draft defined a second implementation here and overwrote
   * it per instance with `Object.defineProperty`, which left unreachable code
   * with different semantics sitting in the class a mobile adapter is meant to
   * read as the reference.
   */
  cancel(): void {
    this.onCancel(this);
  }
}

export interface SpeechSynthesisProviderOptions {
  /** Injected in tests; `globalThis.speechSynthesis` in the browser. */
  synth?: SpeechSynthesis | undefined;
  /** Injected in tests; `globalThis.SpeechSynthesisUtterance` in the browser. */
  utteranceCtor?: typeof SpeechSynthesisUtterance | undefined;
  timeoutMs?: number;
}

export class SpeechSynthesisProvider implements TTSProvider {
  readonly name = 'speech-synthesis';
  /** See the header: a promise to consumers, not a feature detect. */
  readonly supportsBoundary = false;

  readonly #synth: SpeechSynthesis | undefined;
  readonly #Utterance: typeof SpeechSynthesisUtterance | undefined;
  readonly #timeoutMs: number;
  /** The in-flight or settled answer for a voice list that is still empty. */
  #empty: Promise<readonly SpeechSynthesisVoice[]> | null = null;

  #nextId = 1;
  /** Queued but not yet handed to the engine, in order. */
  #queue: Handle[] = [];
  /** The one handle the engine currently has, if any. */
  #current: Handle | null = null;

  constructor(options: SpeechSynthesisProviderOptions = {}) {
    this.#synth =
      options.synth ??
      (typeof globalThis !== 'undefined'
        ? (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis
        : undefined);
    this.#Utterance =
      options.utteranceCtor ??
      (typeof globalThis !== 'undefined'
        ? (globalThis as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance })
            .SpeechSynthesisUtterance
        : undefined);
    this.#timeoutMs = options.timeoutMs ?? VOICES_TIMEOUT_MS;
  }

  /**
   * The voices this browser will admit to, after at most one `voiceschanged`.
   *
   * The wait is memoised, and that matters: a browser with no voices at all
   * (headless Chromium, some Linux desktops) is empty on every call, so without
   * the memo every `SpeakButton` mount — one per review card — re-arms the
   * listener and pays the 500 ms timeout again before it can say why it is
   * disabled. The memo is self-invalidating: once `getVoices()` returns
   * anything, the branch above answers and the stale promise is dropped.
   */
  async nativeVoices(): Promise<readonly SpeechSynthesisVoice[]> {
    const synth = this.#synth;
    if (!synth || typeof synth.getVoices !== 'function') return [];

    const first = synth.getVoices() ?? [];
    if (first.length > 0) {
      this.#empty = null;
      return first;
    }
    if (this.#empty) return this.#empty;

    this.#empty = new Promise((resolve) => {
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        synth.removeEventListener?.('voiceschanged', settle);
        resolve(synth.getVoices() ?? []);
      };
      const timer = setTimeout(settle, this.#timeoutMs);
      if (typeof synth.addEventListener === 'function') {
        synth.addEventListener('voiceschanged', settle);
      }
    });
    return this.#empty;
  }

  async voices(): Promise<readonly TTSVoice[]> {
    return (await this.nativeVoices()).map((voice) => ({
      id: idOf(voice),
      name: voice.name,
      lang: voice.lang,
      isDefault: Boolean(voice.default),
    }));
  }

  /**
   * Forwards the engine's own `voiceschanged`, and drops the empty-list memo
   * so the next `nativeVoices()` asks again rather than returning the promise
   * that resolved to nothing.
   */
  onVoicesChanged(listener: () => void): () => void {
    const synth = this.#synth;
    if (!synth || typeof synth.addEventListener !== 'function') return () => {};
    const handler = () => {
      this.#empty = null;
      listener();
    };
    synth.addEventListener('voiceschanged', handler);
    return () => synth.removeEventListener?.('voiceschanged', handler);
  }

  async available(): Promise<boolean> {
    if (!this.#synth || !this.#Utterance) return false;
    return pickChineseVoice(await this.nativeVoices()) !== null;
  }

  speak(text: string, opts: SpeakOptions = {}): Utterance {
    const body = text.trim();
    const handle = new Handle(this.#nextId++, body, opts, (target) => {
      this.#cancel(target);
    });

    if (!this.#synth || !this.#Utterance || body.length === 0) {
      handle.settle('unavailable');
      return handle;
    }

    this.#queue.push(handle);
    void this.#pump();
    return handle;
  }

  stop(): void {
    const queued = this.#queue;
    this.#queue = [];
    for (const handle of queued) this.#settleCancelled(handle);
    const current = this.#current;
    this.#current = null;
    this.#clearWatchdog();
    if (current) {
      current.cancelled = true;
      // The engine answers a `cancel()` with `error: 'canceled'` on the live
      // utterance, and `onerror` settles it — so settle FIRST and let the guard
      // in `#settleCancelled` make the second arrival a no-op. Emitting after
      // would fire every `cancel` listener twice.
      this.#settleCancelled(current);
    }
    /**
     * **Unconditionally**, not only when this adapter is tracking something.
     *
     * `speechSynthesis` is a single global queue shared with every other
     * script on the page, and this adapter can stop tracking an utterance the
     * engine is still speaking — the watchdog below does exactly that. Before
     * this was unconditional, `stop()` after a watchdog fire was a complete
     * no-op at the engine level: `#current` was null, so the learner's next tap
     * on the speaker was a *Play* that queued a second utterance behind the one
     * still sounding, and nothing on screen could silence either.
     */
    this.#synth?.cancel();
  }

  /** Idempotent: the engine's own `canceled` error arrives after this. */
  #settleCancelled(handle: Handle): void {
    handle.cancelled = true;
    if (handle.isSettled) return;
    handle.emit('cancel', undefined);
    handle.settle('cancelled');
  }

  #cancel(handle: Handle): void {
    if (handle.isSettled) return;
    handle.cancelled = true;
    if (this.#current === handle) {
      this.#current = null;
      this.#clearWatchdog();
      this.#settleCancelled(handle);
      this.#synth?.cancel();
      void this.#pump();
      return;
    }
    this.#queue = this.#queue.filter((queued) => queued !== handle);
    this.#settleCancelled(handle);
  }

  /**
   * The engine does not always answer. Chrome's ~15 s watchdog drops a long
   * utterance without an `end`; a background/foreground transition or a paused
   * `speechSynthesis` can do the same. `#current` is cleared only by an event,
   * so without this one dropped utterance wedges the queue **forever** — every
   * later `speak()` returns a handle that silently never plays, on a surface
   * whose failure mode is already "nothing happens".
   */
  #watchdog: ReturnType<typeof setTimeout> | null = null;

  #clearWatchdog(): void {
    if (this.#watchdog === null) return;
    clearTimeout(this.#watchdog);
    this.#watchdog = null;
  }

  /**
   * Hand the engine the next utterance, if it is idle.
   *
   * **It takes no options.** They come off the handle it dequeues — see
   * `Handle.opts`.
   */
  async #pump(): Promise<void> {
    if (this.#current) return;
    const handle = this.#queue.shift();
    if (!handle) return;
    if (handle.cancelled) {
      void this.#pump();
      return;
    }
    this.#current = handle;
    const opts = handle.opts;

    const synth = this.#synth;
    const Utterance = this.#Utterance;
    const voices = await this.nativeVoices();
    // A second tap can have cancelled this while the voice list was resolving.
    if (handle.cancelled || !synth || !Utterance) {
      if (this.#current === handle) this.#current = null;
      handle.settle(handle.cancelled ? 'cancelled' : 'unavailable');
      void this.#pump();
      return;
    }

    // A named voice that is Cantonese is refused, not honoured: the interface's
    // rule 2. `rank()` returns null for those, so the find below skips them and
    // the ranking picks a Mandarin voice instead.
    const preferred = opts.voiceId
      ? (voices.find((voice) => idOf(voice) === opts.voiceId && rank(voice) !== null) ?? null)
      : null;
    const voice = preferred ?? pickChineseVoice(voices);
    if (!voice) {
      this.#current = null;
      handle.settle('unavailable');
      void this.#pump();
      return;
    }

    const utterance = new Utterance(handle.text);
    handle.live = utterance;
    utterance.voice = voice;
    utterance.lang = opts.lang ?? voice.lang ?? DEFAULT_LANG;
    if (opts.rate !== undefined) utterance.rate = opts.rate;

    const finish = (outcome: UtteranceOutcome) => {
      if (this.#current === handle) {
        this.#current = null;
        this.#clearWatchdog();
      }
      handle.settle(outcome);
      void this.#pump();
    };

    utterance.onstart = () => {
      handle.started = true;
      handle.emit('start', undefined);
    };
    utterance.onend = () => {
      if (handle.isSettled) return;
      handle.emit('end', undefined);
      finish('ended');
    };
    utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
      if (handle.isSettled) return;
      // `interrupted` / `canceled` are what a `cancel()` looks like from the
      // engine's side; they are not errors to report.
      const reason = event.error ?? 'error';
      if (reason === 'interrupted' || reason === 'canceled') {
        handle.emit('cancel', undefined);
        finish('cancelled');
        return;
      }
      handle.emit('error', { message: String(reason) });
      finish('error');
    };
    utterance.onboundary = (event: SpeechSynthesisEvent) => {
      handle.emit('boundary', {
        charIndex: event.charIndex,
        ...(typeof event.charLength === 'number' ? { charLength: event.charLength } : {}),
      });
    };

    // Armed before dispatch and cleared by `finish`, `#cancel` and `stop`.
    // Generous, because the cost of firing early is a cut-off word and the cost
    // of never firing is a permanently silent app.
    this.#clearWatchdog();
    this.#watchdog = setTimeout(
      () => {
        this.#watchdog = null;
        if (this.#current !== handle || handle.isSettled) return;
        /**
         * Settle BEFORE cancelling, and cancel before pumping.
         *
         * The engine may still be holding this utterance — "never answered" is
         * a statement about the events, not about the audio — so it has to be
         * taken off the engine, or the next `speak()` is handed to a
         * synthesiser still speaking the abandoned one. But `cancel()` makes
         * the engine fire `error: 'canceled'` on that same utterance, and
         * `onerror` reads that as a cancellation: cancelling first turned the
         * outcome into `'cancelled'` and swallowed the `error` event, so the
         * one diagnostic this path exists to emit never reached a listener.
         * Settling first makes the engine's echo a no-op through
         * `handle.isSettled`.
         */
        this.#current = null;
        this.#clearWatchdog();
        handle.emit('error', { message: 'the speech engine never answered' });
        handle.settle('error');
        this.#synth?.cancel();
        void this.#pump();
      },
      this.#watchdogMs(handle.text, opts.rate),
    );

    synth.speak(utterance);
  }

  /**
   * Roughly four times the longest plausible utterance, floored at ten seconds
   * and **capped at thirty**.
   *
   * The cap is the half that matters. Without it the timeout scaled with the
   * text, so the longer the utterance the later the guard arrived — for a
   * 40-character block at `BLOCK_RATE` it worked out at 53 seconds, which is
   * most of a minute of a wedged queue and a Stop glyph nothing can clear.
   * That is backwards: the failure this guard exists for is Chrome dropping a
   * **long** utterance at ~15s without an `end`, so the longest utterances are
   * the ones that need it soonest. Thirty seconds is past any utterance Chrome
   * will actually finish and comfortably past the one it cuts.
   *
   * The floor stays ten seconds, including for `sequence.ts`'s one-code-point
   * utterances: firing early cuts a character off mid-sound, and a learner
   * holding for the slow read would hear the sequence stutter for a guard that
   * should almost never fire.
   */
  #watchdogMs(text: string, rate: number | undefined): number {
    const perCharacter = 1_200 / Math.max(0.1, rate ?? 1);
    return Math.min(30_000, Math.max(10_000, [...text].length * perCharacter));
  }
}

let memo: SpeechSynthesisProvider | null = null;

/** The browser provider, made once. */
export function getTTSProvider(): SpeechSynthesisProvider {
  memo ??= new SpeechSynthesisProvider();
  return memo;
}
