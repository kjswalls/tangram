/**
 * `TTSProvider` over the Web Speech API (PLAN.md §3.6).
 *
 * Three things here are load-bearing:
 *
 * 1. **`available()` waits for `voiceschanged`, but not forever.** Chrome
 *    returns an empty list from the first `getVoices()` and fires
 *    `voiceschanged` once the list is populated; Safari populates
 *    synchronously; headless Chromium never fires at all because it has no
 *    voices. So: ask once, and if the list is empty wait for the event with a
 *    500 ms timeout and answer with whatever is there when the timer wins.
 * 2. **A `zh*` voice is the requirement**, not a `zh-CN` one. `zh-TW`,
 *    `zh-HK`, `cmn-Hans-CN` and bare `zh` all read hanzi; matching the exact
 *    tag would report "no voice" on a machine that has three.
 * 3. **`speak()` cancels first.** The utterance queue is global and additive —
 *    tapping the speaker twice without a cancel plays the word twice, back to
 *    back, which is the single most annoying thing a review card can do.
 */

import type { SpeakOptions, TTSProvider } from '@/lib/tts/provider';

/** How long to wait for `voiceschanged` before answering with what we have. */
export const VOICES_TIMEOUT_MS = 500;

const DEFAULT_LANG = 'zh-CN';

/** `zh`, `zh-CN`, `zh_TW`, `cmn-Hans-CN` — anything that reads hanzi. */
export function isChineseVoice(voice: Pick<SpeechSynthesisVoice, 'lang'>): boolean {
  const lang = (voice.lang ?? '').toLowerCase().replace(/_/g, '-');
  return lang === 'zh' || lang.startsWith('zh-') || lang === 'cmn' || lang.startsWith('cmn-');
}

/** The first Chinese voice in the list, preferring one the browser calls default. */
export function pickChineseVoice(
  voices: readonly SpeechSynthesisVoice[],
): SpeechSynthesisVoice | null {
  const chinese = voices.filter(isChineseVoice);
  if (chinese.length === 0) return null;
  return chinese.find((voice) => voice.default) ?? chinese[0]!;
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

  readonly #synth: SpeechSynthesis | undefined;
  readonly #Utterance: typeof SpeechSynthesisUtterance | undefined;
  readonly #timeoutMs: number;

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

  /** The voices this browser will admit to, after at most one `voiceschanged`. */
  async voices(): Promise<readonly SpeechSynthesisVoice[]> {
    const synth = this.#synth;
    if (!synth || typeof synth.getVoices !== 'function') return [];

    const first = synth.getVoices() ?? [];
    if (first.length > 0) return first;

    return new Promise((resolve) => {
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
  }

  async available(): Promise<boolean> {
    if (!this.#synth || !this.#Utterance) return false;
    return pickChineseVoice(await this.voices()) !== null;
  }

  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    const synth = this.#synth;
    const Utterance = this.#Utterance;
    const body = text.trim();
    if (!synth || !Utterance || body.length === 0) return;

    const voice = pickChineseVoice(await this.voices());
    if (!voice) return;

    // One word at a time: the queue is global and additive (see the header).
    synth.cancel();
    const utterance = new Utterance(body);
    utterance.voice = voice;
    utterance.lang = opts.lang ?? voice.lang ?? DEFAULT_LANG;
    if (opts.rate !== undefined) utterance.rate = opts.rate;
    synth.speak(utterance);
  }
}

let memo: SpeechSynthesisProvider | null = null;

/** The browser provider, made once. */
export function getTTSProvider(): SpeechSynthesisProvider {
  memo ??= new SpeechSynthesisProvider();
  return memo;
}
