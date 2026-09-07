/**
 * The text-to-speech seam (PLAN.md §3.6).
 *
 * Speech is a browser capability, not a dependency: the app asks an interface
 * whether a Chinese voice exists and, if one does, hands it a string. The
 * interface exists because the answer is environment-dependent and because
 * headless Chromium — the only browser this build can run — ships no voices at
 * all, so every consumer has to render a sane disabled state rather than assume
 * audio.
 *
 * `available()` is a promise on purpose: `speechSynthesis.getVoices()` is empty
 * on first call in most browsers and only fills after the `voiceschanged`
 * event.
 */

export interface SpeakOptions {
  /** BCP-47 tag handed to the utterance; defaults to the provider's own. */
  lang?: string;
  /** 0.1–10, 1 is the browser default. Slower is the point for a learner. */
  rate?: number;
}

export interface TTSProvider {
  readonly name: string;
  /** Whether this provider can speak Chinese *in this browser, right now*. */
  available(): Promise<boolean>;
  /**
   * Speak `text`. Resolves once the utterance has been queued (not once it has
   * finished), and never rejects: a provider that cannot speak returns quietly
   * rather than throwing into a click handler.
   */
  speak(text: string, opts?: SpeakOptions): Promise<void>;
}
