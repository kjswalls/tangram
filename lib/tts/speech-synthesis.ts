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
 * 3. **`speak()` cancels first.** The utterance queue is global and additive —
 *    tapping the speaker twice without a cancel plays the word twice, back to
 *    back, which is the single most annoying thing a review card can do.
 */

import type { SpeakOptions, TTSProvider } from '@/lib/tts/provider';

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
  /** The in-flight or settled answer for a voice list that is still empty. */
  #empty: Promise<readonly SpeechSynthesisVoice[]> | null = null;

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
  async voices(): Promise<readonly SpeechSynthesisVoice[]> {
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
