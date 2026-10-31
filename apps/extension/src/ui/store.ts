import { useEffect, useState } from 'preact/hooks';

import type { Sentence, Word } from '../core/types';

export type HelpLevel = 'training' | 'peek' | 'immersion';

export interface Settings {
  pinyin: boolean;
  english: boolean;
  toneColours: boolean;
  pauseEach: boolean;
  size: 'sm' | 'md' | 'lg';
  sidebar: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  pinyin: true,
  english: true,
  toneColours: true,
  pauseEach: false,
  size: 'md',
  sidebar: true,
};

export interface Popover {
  word: Word;
  /** The word's box, in viewport coordinates. */
  rect: { left: number; top: number; width: number; height: number };
  /** The sentence it came from, for the "in this line" section. */
  sentenceId: number;
}

export interface State {
  status: 'idle' | 'loading' | 'ready' | 'error';
  message: string;
  title: string;
  zhLabel: string;
  enLabel: string;
  sentences: Sentence[];
  /** Index of the current sentence, -1 before the first. */
  current: number;
  /** Indexes of the zh and en cues playing now, within the current sentence. */
  activeZh: number[];
  activeEn: number[];
  paused: boolean;
  rate: number;
  settings: Settings;
  popover: Popover | null;
  /** Fullscreen hides the sidebar host; the card still shows. */
  fullscreen: boolean;
}

type Listener = (state: State) => void;

/** One store for both shadow roots (the card on the video and the sidebar). */
export class Store {
  private listeners = new Set<Listener>();

  constructor(public state: State) {}

  set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function initialState(settings: Settings): State {
  return {
    status: 'idle',
    message: '',
    title: '',
    zhLabel: '',
    enLabel: '',
    sentences: [],
    current: -1,
    activeZh: [],
    activeEn: [],
    paused: true,
    rate: 1,
    settings,
    popover: null,
    fullscreen: false,
  };
}

export function useStore(store: Store): State {
  const [state, setState] = useState(store.state);
  useEffect(() => store.subscribe(setState), [store]);
  return state;
}

const SETTINGS_KEY = 'kanju.settings';

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] as Partial<Settings> | undefined) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  void chrome.storage.local.set({ [SETTINGS_KEY]: settings }).catch(() => undefined);
}
