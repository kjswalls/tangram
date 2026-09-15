/**
 * A `TTSProvider` that speaks nothing and reports everything (core.md C6).
 *
 * **Headless Chromium has no voices**, so the only state the e2e suite can
 * observe against the real Web Speech adapter is `unavailable` — which makes
 * every behavioural criterion C6 states unobservable outside the unit suite.
 * That is a gap, not a reason to assert less: "the hold gesture is recognised"
 * and "each character lit as it plays" are the two things most likely to be
 * broken by a later refactor and least likely to be caught by a mock in jsdom,
 * because they depend on a real `pointerdown`, a real timer and a real render.
 *
 * So the gallery — which `src/routes.tsx` keeps out of every production build —
 * mounts the control against this: a provider that reports a voice, settles
 * each utterance on a short timer, and fires the `start` the highlight advances
 * on. **It still produces no audio, and the spec that drives it says so**; what
 * it proves is the wiring from the gesture to the lit character, end to end in
 * a browser.
 *
 * It lives beside `fake-dict-store.ts` for the same reason that one does: a
 * double that ships is a second implementation nobody maintains, and the
 * gallery's build-mode guard is what keeps this one out.
 */
import type {
  TTSProvider,
  TTSVoice,
  Utterance,
  UtteranceEventName,
  UtteranceEvents,
  UtteranceOutcome,
} from '@/lib/tts/provider';

/**
 * How long each character "takes".
 *
 * Long enough that a **browser** test can see the mark move — a 120 ms
 * character walked the whole block inside one `expect.poll` backoff step, so
 * the first version of `tests/e2e/core/speaker.spec.ts` polled for 打 and found
 * the sequence already over. Short enough that the spec is not slow.
 */
const UTTERANCE_MS = 400;

type Listeners = {
  [K in UtteranceEventName]: Set<(payload: UtteranceEvents[K]) => void>;
};

class TimedUtterance implements Utterance {
  readonly id: number;
  readonly text: string;
  readonly done: Promise<UtteranceOutcome>;

  #settle!: (outcome: UtteranceOutcome) => void;
  #settled = false;
  #started = false;
  #timers: ReturnType<typeof setTimeout>[] = [];
  readonly #listeners: Listeners = {
    start: new Set(),
    end: new Set(),
    boundary: new Set(),
    cancel: new Set(),
    error: new Set(),
  };

  constructor(id: number, text: string, private readonly onSettled: () => void) {
    this.id = id;
    this.text = text;
    this.done = new Promise((resolve) => {
      this.#settle = resolve;
    });
    // `start` on the next frame, `end` a moment later — the shape a real engine
    // has, and the shape `lib/tts/sequence.ts` advances on.
    this.#timers.push(
      setTimeout(() => {
        this.#started = true;
        this.#emit('start', undefined);
      }, 10),
      setTimeout(() => {
        this.#emit('end', undefined);
        this.#finish('ended');
      }, UTTERANCE_MS),
    );
  }

  #emit<K extends UtteranceEventName>(event: K, payload: UtteranceEvents[K]): void {
    for (const listener of [...this.#listeners[event]]) listener(payload);
  }

  #finish(outcome: UtteranceOutcome): void {
    if (this.#settled) return;
    this.#settled = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];
    this.onSettled();
    this.#settle(outcome);
  }

  on<K extends UtteranceEventName>(
    event: K,
    listener: (payload: UtteranceEvents[K]) => void,
  ): () => void {
    // The interface's replay rule: a late `start` subscriber still gets it.
    if (event === 'start' && this.#started) {
      (listener as (payload: UtteranceEvents['start']) => void)(undefined);
    }
    this.#listeners[event].add(listener);
    return () => {
      this.#listeners[event].delete(listener);
    };
  }

  cancel(): void {
    if (this.#settled) return;
    this.#emit('cancel', undefined);
    this.#finish('cancelled');
  }
}

export class GalleryTTSProvider implements TTSProvider {
  readonly name = 'gallery';
  /**
   * `false`, which is the case that matters: two of the three engines cannot be
   * relied on for boundary events (STACK register #19), and the sequence never
   * reads them anyway.
   */
  readonly supportsBoundary = false;

  #nextId = 1;
  #queued = new Set<TimedUtterance>();

  async available(): Promise<boolean> {
    return true;
  }

  async voices(): Promise<readonly TTSVoice[]> {
    return [{ id: 'gallery-zh', name: 'Gallery', lang: 'zh-CN', isDefault: true }];
  }

  speak(text: string): Utterance {
    const body = text.trim();
    const utterance = new TimedUtterance(this.#nextId++, body, () => {
      this.#queued.delete(utterance);
    });
    if (body.length === 0) utterance.cancel();
    else this.#queued.add(utterance);
    return utterance;
  }

  stop(): void {
    for (const utterance of [...this.#queued]) utterance.cancel();
    this.#queued.clear();
  }

  onVoicesChanged(): () => void {
    // No signal, honestly reported: the consumer's first answer stands.
    return () => undefined;
  }
}
