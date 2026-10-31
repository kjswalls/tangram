import { useEffect, useRef, useState } from 'preact/hooks';

import type { Sentence, Word } from '../core/types';
import type { Controller } from './controller';
import { useStore, type Settings, type State } from './store';

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function WordView(props: {
  word: Word;
  settings: Settings;
  onPick?: (word: Word, el: HTMLElement) => void;
  selected?: boolean;
}) {
  const { word, settings, onPick, selected } = props;
  if (word.kind === 'text') {
    return (
      <span class="w w-text">
        {settings.pinyin && <span class="py">&nbsp;</span>}
        <span class="hz">{word.text}</span>
      </span>
    );
  }
  const syllables = word.syllables ?? [];
  return (
    <span
      class={`w${onPick ? ' w-pick' : ''}${selected ? ' w-selected' : ''}`}
      onClick={(event) => {
        event.stopPropagation();
        onPick?.(word, event.currentTarget as HTMLElement);
      }}
    >
      {settings.pinyin && (
        <span class="py">
          {syllables.length > 0
            ? syllables.map((syllable, i) => (
                <span class={settings.toneColours ? `t${word.tones?.[i] ?? 0}` : ''}>{syllable}</span>
              ))
            : ' '}
        </span>
      )}
      <span class="hz">{word.text}</span>
    </span>
  );
}

function ZhText(props: {
  sentence: Sentence;
  settings: Settings;
  activeZh?: number[];
  onPick?: (word: Word, el: HTMLElement) => void;
  selected?: Word | null;
}) {
  const { sentence, settings, activeZh, onPick, selected } = props;
  const anyActive = (activeZh?.length ?? 0) > 0;
  return (
    <div class="zh">
      {sentence.zh.map((line, i) => (
        <span class={`line${anyActive && !activeZh?.includes(i) ? ' dim' : ''}`}>
          {line.words.map((word) => (
            <WordView word={word} settings={settings} onPick={onPick} selected={selected === word} />
          ))}
        </span>
      ))}
    </div>
  );
}

function EnText(props: { sentence: Sentence; activeEn?: number[] }) {
  const { sentence, activeEn } = props;
  const anyActive = (activeEn?.length ?? 0) > 0;
  return (
    <div class="en">
      {sentence.en.map((cue, i) => (
        <span class={anyActive && !activeEn?.includes(i) ? 'dim' : ''}>{cue.text} </span>
      ))}
    </div>
  );
}

/** The card on the video. */
export function Card({ controller }: { controller: Controller }) {
  const state = useStore(controller.store);
  const sentence = state.sentences[state.current];
  if (state.status !== 'ready' || !sentence) return null;
  return (
    <div class={`card size-${state.settings.size}`} onClick={(event) => event.stopPropagation()}>
      <div class="card-controls">
        <button title="Previous sentence (A)" onClick={() => controller.previous()}>‹</button>
        <button title="Replay sentence (R)" onClick={() => controller.replay()}>↺</button>
      </div>
      <div class="card-body">
        <ZhText
          sentence={sentence}
          settings={state.settings}
          activeZh={state.activeZh}
          selected={state.popover?.word ?? null}
          onPick={(word, el) => controller.openPopover(word, el, sentence.id)}
        />
        {state.settings.english && <EnText sentence={sentence} activeEn={state.activeEn} />}
      </div>
      <div class="card-controls">
        <button title="Next sentence (D)" onClick={() => controller.next()}>›</button>
      </div>
      {state.popover && <PopoverView state={state} controller={controller} />}
    </div>
  );
}

function PopoverView({ state, controller }: { state: State; controller: Controller }) {
  const popover = state.popover!;
  const { word } = popover;
  const [first, ...others] = word.readings;
  return (
    <div
      class="popover"
      style={{ left: `${Math.max(0, popover.rect.left)}px` }}
      onClick={(event) => event.stopPropagation()}
    >
      <div class="pop-head">
        <span class="pop-hz">{word.text}</span>
        <span class="pop-py">{word.pinyin ?? first?.pinyin}</span>
        {first?.hsk ? <span class="pop-hsk">HSK {first.hsk === 7 ? '7–9' : first.hsk}</span> : null}
        <button class="pop-close" title="Close (Esc)" onClick={() => controller.closePopover()}>×</button>
      </div>
      {first ? (
        <ol class="pop-glosses">
          {first.glosses.slice(0, 10).map((gloss) => (
            <li>{gloss}</li>
          ))}
        </ol>
      ) : (
        <p class="pop-empty">Not in the dictionary. It may be a name, or a word the splitter got wrong.</p>
      )}
      {others.length > 0 && (
        <div class="pop-others">
          {others.slice(0, 3).map((reading) => (
            <div>
              <span class="pop-other-py">{reading.pinyin}</span> {reading.glosses.slice(0, 3).join('; ')}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Toggle(props: { label: string; value: boolean; onChange: (value: boolean) => void; hint?: string }) {
  return (
    <div class="setting">
      <span>
        {props.label}
        {props.hint && <span class="hint">{props.hint}</span>}
      </span>
      <span class="seg">
        <button class={props.value ? 'on' : ''} onClick={() => props.onChange(true)}>ON</button>
        <button class={!props.value ? 'on' : ''} onClick={() => props.onChange(false)}>OFF</button>
      </span>
    </div>
  );
}

function Lines({ state, controller }: { state: State; controller: Controller }) {
  const list = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const programmatic = useRef(false);

  useEffect(() => {
    if (!following || !list.current) return;
    const el = list.current.querySelector<HTMLElement>(`[data-id="${state.current}"]`);
    if (!el) return;
    programmatic.current = true;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => (programmatic.current = false), 600);
  }, [state.current, following]);

  if (state.status === 'loading') return <p class="note">Loading subtitles…</p>;
  if (state.status === 'error') {
    return (
      <div class="note error">
        <p>{state.message}</p>
        <button class="retry" onClick={() => void controller.reload()}>RETRY</button>
      </div>
    );
  }
  if (state.status === 'idle') return <p class="note">Open a video with Chinese subtitles to start.</p>;

  return (
    <div class="lines-wrap">
      <div
        class="lines"
        ref={list}
        onScroll={() => {
          if (!programmatic.current) setFollowing(false);
        }}
      >
        {state.sentences.map((sentence, i) => (
          <div
            class={`row${i === state.current ? ' current' : ''}`}
            data-id={i}
            onClick={() => {
              controller.seekTo(i);
              setFollowing(true);
            }}
          >
            <div class="time">
              {formatTime(sentence.startMs)}
              {i === state.current && <span class="dot">●</span>}
            </div>
            <ZhText sentence={sentence} settings={state.settings} />
            {state.settings.english && <EnText sentence={sentence} />}
          </div>
        ))}
      </div>
      {!following && (
        <button class="jump" onClick={() => setFollowing(true)}>
          ↓ JUMP TO LIVE
        </button>
      )}
    </div>
  );
}

function SettingsPanel({ state, controller }: { state: State; controller: Controller }) {
  const s = state.settings;
  const set = (patch: Partial<Settings>) => controller.updateSettings(patch);
  return (
    <div class="settings">
      <div class="section">ESSENTIALS</div>
      <div class="keys">
        <div class="key"><b>A</b><span>PREV</span></div>
        <div class="key"><b>D</b><span>NEXT</span></div>
        <div class="key"><b>R</b><span>REPLAY</span></div>
      </div>
      <Toggle label="PINYIN" value={s.pinyin} onChange={(pinyin) => set({ pinyin })} />
      <Toggle label="TONE COLOURS" value={s.toneColours} onChange={(toneColours) => set({ toneColours })} />
      <Toggle label="ENGLISH LINE" value={s.english} onChange={(english) => set({ english })} />
      <Toggle label="PAUSE EACH SENTENCE" value={s.pauseEach} onChange={(pauseEach) => set({ pauseEach })} />
      <div class="setting">
        <span>CARD SIZE</span>
        <span class="seg">
          {(['sm', 'md', 'lg'] as const).map((size) => (
            <button class={s.size === size ? 'on' : ''} onClick={() => set({ size })}>
              {size.toUpperCase()}
            </button>
          ))}
        </span>
      </div>
      <div class="setting">
        <span>PLAYBACK RATE</span>
        <span class="seg">
          {[0.5, 0.75, 1, 1.25].map((rate) => (
            <button class={state.rate === rate ? 'on' : ''} onClick={() => controller.setRate(rate)}>
              {rate}×
            </button>
          ))}
        </span>
      </div>
      <div class="section">KEYBOARD</div>
      <dl class="shortcuts">
        <dt>Previous / next sentence</dt><dd>A / D</dd>
        <dt>Replay sentence</dt><dd>R</dd>
        <dt>Toggle pinyin</dt><dd>P</dd>
        <dt>Toggle English</dt><dd>E</dd>
        <dt>Toggle tone colours</dt><dd>H</dd>
        <dt>Slower / faster</dt><dd>[ / ]</dd>
        <dt>Show / hide sidebar</dt><dd>S</dd>
        <dt>Close popover</dt><dd>Esc</dd>
      </dl>
    </div>
  );
}

/** The sidebar, beside the page. */
export function Sidebar({ controller }: { controller: Controller }) {
  const state = useStore(controller.store);
  const [tab, setTab] = useState<'lines' | 'settings'>('lines');
  if (!state.settings.sidebar || state.fullscreen) {
    return (
      <button class="reopen" title="Show Kànjù (S)" onClick={() => controller.updateSettings({ sidebar: true })}>
        看
      </button>
    );
  }
  return (
    <aside class="sidebar">
      <header>
        <span class="brand">
          <span class="dot">●</span> KÀNJÙ <span class="brand-zh">看剧</span>
        </span>
        <button title="Hide (S)" onClick={() => controller.updateSettings({ sidebar: false })}>→</button>
      </header>
      <nav>
        <button class={tab === 'lines' ? 'on' : ''} onClick={() => setTab('lines')}>LINES</button>
        <button class={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>SETTINGS</button>
      </nav>
      <main>{tab === 'lines' ? <Lines state={state} controller={controller} /> : <SettingsPanel state={state} controller={controller} />}</main>
      <footer>
        <div class="transport">
          <button title="Previous (A)" onClick={() => controller.previous()}>⏮</button>
          <button class="play" title="Play / pause" onClick={() => controller.togglePlay()}>
            {state.paused ? '▶' : '❚❚'}
          </button>
          <button title="Next (D)" onClick={() => controller.next()}>⏭</button>
          <button title="Replay (R)" onClick={() => controller.replay()}>↺</button>
        </div>
        {state.status === 'ready' && (
          <div class="tracks">
            {state.zhLabel} · {state.enLabel} ·{' '}
            <a href={controller.attributionUrl} target="_blank" rel="noreferrer">
              CC-CEDICT
            </a>
          </div>
        )}
      </footer>
    </aside>
  );
}
