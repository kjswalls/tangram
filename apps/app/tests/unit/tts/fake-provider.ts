/**
 * A hand-driven `TTSProvider` for the unit tests (docs/plans/core.md C2).
 *
 * It implements the interface and nothing else: no timers, no engine, no audio.
 * Every transition — `start`, `boundary`, `end`, `error` — is triggered by the
 * test, so a sequence's behaviour is asserted against the contract rather than
 * against whatever a fake clock happened to do.
 *
 * It lives under `tests/unit/tts/` rather than in `lib/` on purpose: it is a
 * test double, and a double that ships is a second implementation nobody
 * maintains. `ios.md` and `android.md` should point their own adapters at
 * `provider.test.ts`, not import this.
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

type Listeners = {
  [K in UtteranceEventName]: Set<(payload: UtteranceEvents[K]) => void>;
};

class FakeUtterance implements Utterance {
  readonly id: number;
  readonly text: string;
  readonly options: SpeakOptions;
  readonly done: Promise<UtteranceOutcome>;

  #settle!: (outcome: UtteranceOutcome) => void;
  settled = false;
  /** The interface's replay rule: a late `start` subscriber still gets it. */
  started = false;
  readonly #listeners: Listeners = {
    start: new Set(),
    end: new Set(),
    boundary: new Set(),
    cancel: new Set(),
    error: new Set(),
  };

  constructor(
    id: number,
    text: string,
    options: SpeakOptions,
    private readonly onCancel: (utterance: FakeUtterance) => void,
  ) {
    this.id = id;
    this.text = text;
    this.options = options;
    this.done = new Promise((resolve) => {
      this.#settle = resolve;
    });
  }

  on<K extends UtteranceEventName>(
    event: K,
    listener: (payload: UtteranceEvents[K]) => void,
  ): () => void {
    // `start` replays, per the interface. The fake honours it so that a
    // consumer tested against the fake behaves the same against an adapter.
    if (event === 'start' && this.started) {
      (listener as (payload: UtteranceEvents['start']) => void)(undefined);
    }
    this.#listeners[event].add(listener);
    return () => {
      this.#listeners[event].delete(listener);
    };
  }

  emit<K extends UtteranceEventName>(event: K, payload: UtteranceEvents[K]): void {
    for (const listener of [...this.#listeners[event]]) listener(payload);
  }

  settle(outcome: UtteranceOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.#settle(outcome);
  }

  cancel(): void {
    if (this.settled) return;
    this.onCancel(this);
    this.emit('cancel', undefined);
    this.settle('cancelled');
  }
}

export interface FakeProviderOptions {
  supportsBoundary?: boolean;
  /** Every `speak` settles `unavailable`, as a browser with no Chinese voice does. */
  voiceless?: boolean;
  /**
   * Fire `start` from inside `speak()`, before any consumer can subscribe —
   * the shape a Capacitor adapter produces, since that plugin has no start
   * event of its own and one has to be synthesised at dispatch. The interface's
   * replay rule is what makes this work, and this flag is how it is tested.
   */
  startsEagerly?: boolean;
}

export class FakeProvider implements TTSProvider {
  readonly name = 'fake';
  readonly supportsBoundary: boolean;

  /** Everything ever handed to `speak`, settled or not, in order. */
  readonly spoken: { text: string; options: SpeakOptions }[] = [];
  /** The unsettled ones. */
  queued: FakeUtterance[] = [];

  #nextId = 1;
  #voicesChanged: (() => void)[] = [];
  #voiceless: boolean;
  readonly #startsEagerly: boolean;

  constructor(options: FakeProviderOptions = {}) {
    this.supportsBoundary = options.supportsBoundary ?? false;
    this.#voiceless = options.voiceless ?? false;
    this.#startsEagerly = options.startsEagerly ?? false;
  }

  async available(): Promise<boolean> {
    return !this.#voiceless;
  }

  onVoicesChanged(listener: () => void): () => void {
    this.#voicesChanged.push(listener);
    return () => {
      this.#voicesChanged = this.#voicesChanged.filter((fn) => fn !== listener);
    };
  }

  /** How many subscribers are listening, so an unmount leak is visible. */
  get voicesChangedListeners(): number {
    return this.#voicesChanged.length;
  }

  /**
   * What a browser does when its voice list finally loads — the case a
   * consumer that asks `available()` once on mount gets wrong.
   */
  loadVoices(): void {
    this.#voiceless = false;
    for (const fn of [...this.#voicesChanged]) fn();
  }

  async voices(): Promise<readonly TTSVoice[]> {
    return this.#voiceless ? [] : [{ id: 'fake-zh', name: 'Fake', lang: 'zh-CN', isDefault: true }];
  }

  speak(text: string, options: SpeakOptions = {}): Utterance {
    const body = text.trim();
    const utterance = new FakeUtterance(this.#nextId++, body, options, (cancelled) => {
      this.queued = this.queued.filter((queued) => queued !== cancelled);
    });
    if (body.length === 0) {
      utterance.settle('unavailable');
      return utterance;
    }
    this.spoken.push({ text: body, options });
    if (this.#voiceless) {
      utterance.settle('unavailable');
      return utterance;
    }
    this.queued.push(utterance);
    if (this.#startsEagerly) {
      utterance.started = true;
      utterance.emit('start', undefined);
    }
    return utterance;
  }

  stop(): void {
    const queued = this.queued;
    this.queued = [];
    for (const utterance of queued) {
      utterance.emit('cancel', undefined);
      utterance.settle('cancelled');
    }
  }

  // --- the hand crank -------------------------------------------------------

  /** The most recently queued, unsettled utterance. Throws if there is none. */
  get last(): FakeUtterance {
    const utterance = this.queued.at(-1);
    if (!utterance) throw new Error('no utterance is queued');
    return utterance;
  }

  #find(id: number): FakeUtterance {
    const utterance = this.queued.find((queued) => queued.id === id);
    if (!utterance) throw new Error(`utterance ${id} is not queued`);
    return utterance;
  }

  start(id: number): void {
    const utterance = this.#find(id);
    utterance.started = true;
    utterance.emit('start', undefined);
  }

  boundary(id: number, charIndex: number, charLength?: number): void {
    this.#find(id).emit('boundary', {
      charIndex,
      ...(charLength === undefined ? {} : { charLength }),
    });
  }

  end(id: number): void {
    const utterance = this.#find(id);
    this.queued = this.queued.filter((queued) => queued !== utterance);
    utterance.emit('end', undefined);
    utterance.settle('ended');
  }

  fail(id: number, message: string): void {
    const utterance = this.#find(id);
    this.queued = this.queued.filter((queued) => queued !== utterance);
    utterance.emit('error', { message });
    utterance.settle('error');
  }

  /**
   * Let the sequence's `await`s run. A sequence advances on a settled promise,
   * so a test that cranks the engine without yielding is asserting against a
   * state the consumer has not seen yet.
   */
  async settleMicrotasks(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  }
}
