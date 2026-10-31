import { groupSentences, sentenceAt } from '../core/group';
import type { Sentence, Word } from '../core/types';
import type { Player, SiteAdapter } from '../content/adapters/types';
import { sendToBackground } from '../content/messages';
import { saveSettings, Store, type Settings } from './store';

const RATES = [0.5, 0.75, 1, 1.25, 1.5];

/** Indexes of the cues inside `sentence` that are playing at `ms`. */
function activeIn(cues: readonly { startMs: number; endMs: number }[], ms: number): number[] {
  const out: number[] = [];
  cues.forEach((cue, i) => {
    if (cue.startMs <= ms && ms < cue.endMs) out.push(i);
  });
  return out;
}

function sameList(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * Everything that changes the state: playback following, navigation, the
 * popover, settings. The two Preact roots only read the store and call these.
 */
export class Controller {
  readonly attributionUrl = chrome.runtime.getURL('ATTRIBUTION.md');
  private frame = 0;
  private pausedAfter = -1;
  private episode: string | null = null;

  constructor(
    readonly store: Store,
    private readonly adapter: SiteAdapter,
  ) {}

  private get player(): Player | null {
    return this.adapter.player();
  }

  private get sentences(): Sentence[] {
    return this.store.state.sentences;
  }

  /** Load the current episode's tracks, if it changed. */
  async load(): Promise<void> {
    const episode = this.adapter.episodeId();
    if (episode === this.episode) return;
    this.episode = episode;
    this.store.set({ popover: null, sentences: [], current: -1, activeZh: [], activeEn: [] });
    if (!episode) {
      this.adapter.hideNativeSubtitles(false);
      this.store.set({ status: 'idle', message: '' });
      return;
    }
    this.store.set({ status: 'loading', message: '' });
    try {
      const tracks = await this.adapter.loadTracks();
      const annotated = await sendToBackground({ type: 'annotate', zh: tracks.zh });
      if (!annotated.ok) throw new Error(annotated.error);
      if (this.episode !== episode) return;
      const sentences = groupSentences(annotated.lines, tracks.en);
      this.adapter.hideNativeSubtitles(true);
      this.store.set({
        status: 'ready',
        title: tracks.title,
        zhLabel: tracks.zhLabel,
        enLabel: tracks.enLabel,
        sentences,
      });
      this.pausedAfter = -1;
    } catch (error) {
      if (this.episode !== episode) return;
      this.adapter.hideNativeSubtitles(false);
      this.store.set({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Forget the episode and load it again (the sidebar's Retry). */
  reload(): Promise<void> {
    this.episode = null;
    return this.load();
  }

  start(): void {
    const tick = (): void => {
      this.follow();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
  }

  /** Called every frame: which sentence and which cues are playing, and pause-each. */
  private follow(): void {
    const player = this.player;
    const state = this.store.state;
    const fullscreen = document.fullscreenElement !== null;
    if (!player || state.status !== 'ready') {
      if (fullscreen !== state.fullscreen) this.store.set({ fullscreen });
      return;
    }
    const ms = player.currentMs();
    const paused = player.isPaused();
    const rate = player.rate();

    if (state.settings.pauseEach && !paused && state.current >= 0 && this.pausedAfter !== state.current) {
      const sentence = this.sentences[state.current]!;
      if (ms >= sentence.endMs - 60 && ms < sentence.endMs + 400) {
        this.pausedAfter = state.current;
        player.pause();
        return;
      }
    }

    const current = sentenceAt(this.sentences, ms);
    const sentence = this.sentences[current];
    const activeZh = sentence ? activeIn(sentence.zh, ms) : [];
    const activeEn = sentence ? activeIn(sentence.en, ms) : [];
    if (
      current !== state.current ||
      paused !== state.paused ||
      rate !== state.rate ||
      fullscreen !== state.fullscreen ||
      !sameList(activeZh, state.activeZh) ||
      !sameList(activeEn, state.activeEn)
    ) {
      const patch: Partial<typeof state> = { current, paused, rate, activeZh, activeEn, fullscreen };
      if (current !== state.current) patch.popover = null;
      this.store.set(patch);
    }
  }

  seekTo(index: number): void {
    const sentence = this.sentences[index];
    const player = this.player;
    if (!sentence || !player) return;
    // Land a hair early so the first syllable isn't clipped.
    player.seek(sentence.startMs - 100);
    this.pausedAfter = -1;
    this.store.set({ current: index, popover: null });
    player.play();
  }

  previous(): void {
    const { current } = this.store.state;
    this.seekTo(Math.max(0, current - 1));
  }

  next(): void {
    const { current } = this.store.state;
    this.seekTo(Math.min(this.sentences.length - 1, current + 1));
  }

  replay(): void {
    this.seekTo(Math.max(0, this.store.state.current));
  }

  togglePlay(): void {
    const player = this.player;
    if (!player) return;
    if (player.isPaused()) {
      this.store.set({ popover: null });
      player.play();
    } else {
      player.pause();
    }
  }

  setRate(rate: number): void {
    this.player?.setRate(rate);
    this.store.set({ rate });
  }

  nudgeRate(direction: -1 | 1): void {
    const now = this.player?.rate() ?? 1;
    const at = RATES.findIndex((rate) => rate >= now - 0.001);
    const next = RATES[Math.min(RATES.length - 1, Math.max(0, (at === -1 ? 2 : at) + direction))]!;
    this.setRate(next);
  }

  updateSettings(patch: Partial<Settings>): void {
    const settings = { ...this.store.state.settings, ...patch };
    this.store.set({ settings });
    saveSettings(settings);
  }

  openPopover(word: Word, el: HTMLElement, sentenceId: number): void {
    const card = el.closest('.card');
    const box = el.getBoundingClientRect();
    const origin = card?.getBoundingClientRect() ?? { left: 0, top: 0, width: 340 };
    this.player?.pause();
    this.store.set({
      popover: {
        word,
        sentenceId,
        // Under the word, but kept inside the card's width (the popover is 340px).
        rect: {
          left: Math.max(0, Math.min(box.left - origin.left, origin.width - 340)),
          top: box.top - origin.top,
          width: box.width,
          height: box.height,
        },
      },
    });
  }

  closePopover(): void {
    if (this.store.state.popover) this.store.set({ popover: null });
  }

  /** Returns true when the key was Kànjù's, so the page never sees it. */
  handleKey(event: KeyboardEvent): boolean {
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return false;
    const s = this.store.state.settings;
    switch (event.key.toLowerCase()) {
      case 'a':
        this.previous();
        return true;
      case 'd':
        this.next();
        return true;
      case 'r':
        this.replay();
        return true;
      case 'p':
        if (event.shiftKey) return false;
        this.updateSettings({ pinyin: !s.pinyin });
        return true;
      case 'e':
        this.updateSettings({ english: !s.english });
        return true;
      case 'h':
        this.updateSettings({ toneColours: !s.toneColours });
        return true;
      case 's':
        this.updateSettings({ sidebar: !s.sidebar });
        return true;
      case '[':
        this.nudgeRate(-1);
        return true;
      case ']':
        this.nudgeRate(1);
        return true;
      case 'escape':
        if (!this.store.state.popover) return false;
        this.closePopover();
        return true;
      default:
        return false;
    }
  }
}
