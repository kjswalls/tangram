'use client';

/**
 * The gallery (docs/plans/core.md C1).
 *
 * Not decoration: it is what makes every later phase reviewable without driving
 * the whole app, and it is where the adversarial review looks first. It also
 * carries **the composite states that are otherwise only reachable by breaking
 * something** — the dictionary's four states and the ask panel's three answer
 * states — with the same test ids C4a's and C7's specs use, so those phases
 * cannot quietly skip them (core.md R9 is the risk this closes).
 *
 * **It is not in a production build.** `src/routes.tsx` adds its route inside a
 * `import.meta.env.VITE_TANGRAM_GALLERY` guard that Vite substitutes at build
 * time, so the whole subtree tree-shakes out unless the flag is set — and only
 * `pnpm e2e` sets it. `tests/e2e/core/gallery-excluded.spec.ts` builds without
 * the flag, serves the output, and asserts both that `/gallery` does not render
 * and that no gallery module reaches the bundle. The negative case has to be
 * tested or the guard rots.
 *
 * `pnpm smoke` needs no exemption: W2 derives its cases from the production
 * route table, which by construction has no `/gallery` in it. **W2 must not
 * "fix" the missing case by adding one.**
 */
import { useEffect, useState } from 'react';

import { DictGate } from '@/components/dict/dict-gate';
import { DictStatusView } from '@/components/dict/dict-status';
import { Section, Row } from '@/components/gallery/section';
import { FakeDictStore, TOTAL } from '@/components/gallery/fake-dict-store';
import { GalleryTTSProvider } from '@/components/gallery/fake-tts';
import { passageRuns } from '@/components/gallery/passage';
import { HanziText } from '@/components/hanzi/hanzi-text';
import { SpeakControl } from '@/components/hanzi/speak-control';
import {
  ASK_OFFLINE_CHIP,
  ASK_UNGROUNDED_BODY,
  ASK_UNGROUNDED_TITLE,
  type AskState,
} from '@/components/lookup/ask-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { TabBar, type TabItem } from '@/components/ui/tab-bar';
import type { PinyinDisplay } from '@/lib/db/schema';
import type { DictStatus } from '@/lib/dict/store';

/**
 * The string `tests/e2e/core/gallery-excluded.spec.ts` looks for in a
 * production bundle. **Exported and rendered from here so a copy edit moves
 * both**: as a literal copied into the spec it was prose in one JSX paragraph,
 * and rewording the intro would have left the tree-shake check passing against
 * a bundle that contained the entire gallery.
 */
/**
 * The three `pinyinDisplay` states, side by side (core.md C3).
 *
 * Each column passes `display` explicitly instead of reading the provider, so
 * the gallery shows all three at once — the setting is one value and a review
 * that had to toggle it three times would compare three screenshots taken at
 * three moments.
 */
const PASSAGE_MODES: readonly { key: PinyinDisplay; label: string; note: string }[] = [
  { key: 'always', label: "'always'", note: 'the default — every reading, band reserved' },
  { key: 'tap', label: "'tap'", note: 'nothing until a tap; then that word only' },
  { key: 'never', label: "'never'", note: 'no <rt> anywhere, no band' },
];

/**
 * 200 and 500 characters. Both are computed once at module scope: building
 * them inside the component would hand `<HanziText>` a new array identity on
 * every render and defeat the `useMemo` over `runs` that keeps a 500-character
 * passage from re-aligning on each keystroke elsewhere on the page.
 */
const PASSAGE_200 = passageRuns(200);
const PASSAGE_500 = passageRuns(500);

export const GALLERY_MARKER = 'Every primitive in every variant';

/** The three tabs C7 will mount for real. Named here so the shape is reviewable. */
const TABS: readonly TabItem[] = [
  // §1 assigns the accents by meaning: jade is Look up, vermillion is Practice.
  // Library has no colour of its own and takes the neutral treatment.
  { key: 'look-up', label: 'Look up', accent: 'lookup' },
  { key: 'practice', label: 'Practice', accent: 'practice' },
  { key: 'library', label: 'Library' },
];

/**
 * Tier-2 tokens only — the gallery may not name a hex any more than a screen
 * may. **Exported**, along with `CONTRAST_PAIRS` below, because both are read
 * through `var(${'\u0024'}{token})` interpolation, which
 * `tests/unit/ui/tokens.test.ts`'s "every var(--…) names a declared token"
 * regex cannot see. `tests/unit/ui/gallery-tokens.test.ts` closes that hole by
 * checking these lists through TypeScript instead.
 */
export const SWATCHES: readonly { token: string; role: string }[] = [
  { token: '--paper', role: 'page ground' },
  { token: '--surface', role: 'cards' },
  { token: '--ink', role: 'body text' },
  { token: '--muted', role: 'secondary text' },
  { token: '--border', role: 'the 1px card border' },
  { token: '--practice', role: 'vermillion — Practice, the one primary action' },
  { token: '--practice-soft', role: 'vermillion tint — OPEN, the owner confirms this one' },
  { token: '--lookup', role: 'jade — Look up, "learning"' },
  { token: '--lookup-soft', role: 'jade tint' },
  { token: '--new', role: 'gold — "new"' },
  { token: '--new-soft', role: 'gold tint' },
  { token: '--warning', role: 'warnings (not in §11; see app/tokens.css)' },
  { token: '--warning-soft', role: 'warning tint' },
  { token: '--muted-on-tint', role: 'secondary text on a soft tint' },
  { token: '--skeleton', role: 'a loading placeholder (not in §11; see app/tokens.css)' },
  { token: '--on-accent', role: 'text on a filled accent' },
];

/** The three steps of the settled radius scale. See the note at the call site. */
const RADII: readonly { token: string; label: string }[] = [
  { token: 'var(--r-sm)', label: 'sm 12' },
  { token: 'var(--r-md)', label: 'md 16' },
  { token: 'var(--r-lg)', label: 'lg 24' },
];

const DICT_STATES: readonly { key: string; status: DictStatus }[] = [
  { key: 'absent', status: { state: 'absent' } },
  { key: 'preparing', status: { state: 'preparing', received: 5_900_000, total: 13_900_000 } },
  { key: 'preparing-indeterminate', status: { state: 'preparing' } },
  { key: 'ready', status: { state: 'ready', version: '1.3.20251213' } },
  {
    key: 'failed-download',
    status: { state: 'failed', reason: 'download', message: 'Connection reset after 6.1 MB' },
  },
  {
    key: 'failed-import',
    status: { state: 'failed', reason: 'import', message: 'OPFS: NotAllowedError' },
  },
  {
    key: 'failed-storage',
    status: { state: 'failed', reason: 'storage', message: 'QuotaExceededError' },
  },
  {
    key: 'failed-corrupt',
    status: { state: 'failed', reason: 'corrupt', message: 'sha256 mismatch' },
  },
];

/** The same two components, parameterised by source — C4a part three. */
const ASSET_STATES: readonly { key: string; status: DictStatus }[] = [
  { key: 'asset-absent', status: { state: 'absent' } },
  {
    key: 'asset-preparing',
    status: { state: 'preparing', received: 22_000_000, total: 43_200_000 },
  },
  {
    key: 'asset-failed-storage',
    status: { state: 'failed', reason: 'storage', message: 'ENOSPC' },
  },
];

const ASK_STATES: readonly { key: string; state: AskState }[] = [
  { key: 'idle', state: { name: 'idle' } },
  { key: 'thinking', state: { name: 'thinking' } },
  { key: 'unavailable', state: { name: 'unavailable', reason: 'offline' } },
  { key: 'ungrounded', state: { name: 'ungrounded', rejected: 3 } },
];

/**
 * The gallery's stand-in for C7's ask panel. It renders the three states'
 * *chrome* only — C7 builds the real panel over the real module — but the test
 * ids are the ones C7's three fixtures assert, so the two cannot disagree about
 * what "the unavailable state" is on screen.
 */
function AskStateSpecimen({ state }: { state: AskState }) {
  return (
    <Card
      data-testid={`ask-state-${state.name}`}
      data-ask-state={state.name}
      className="flex flex-col gap-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="hanzi text-2xl">打算</span>
        <Button size="sm" variant="lookup" data-testid="ask-add">
          Add
        </Button>
      </div>
      <p className="text-sm text-muted">to plan; to intend</p>

      {state.name === 'thinking' ? (
        <div className="flex flex-col items-start gap-2 border-t border-border pt-3">
          <Chip tone="lookup">AI</Chip>
          <Skeleton className="w-4/5" />
          <Skeleton className="w-3/5" />
          <p className="text-xs text-muted">
            The dictionary card above is already addable; the answer never blocks it.
          </p>
        </div>
      ) : null}

      {state.name === 'unavailable' ? (
        <div className="border-t border-border pt-3">
          <Chip tone="neutral" data-testid="ask-offline-chip">
            {ASK_OFFLINE_CHIP}
          </Chip>
        </div>
      ) : null}

      {state.name === 'ungrounded' ? (
        <div className="border-t border-border pt-3">
          <EmptyState data-testid="ask-ungrounded" title={ASK_UNGROUNDED_TITLE}>
            {ASK_UNGROUNDED_BODY}
          </EmptyState>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * The pairs C0's review measured, re-measured live from whatever the cascade
 * currently computes — so the numbers follow a token edit and follow the theme,
 * rather than being a comment that goes stale.
 *
 * Three of them failed AA until the first-run audit moved three settled hexes
 * one step each (the header of app/tokens.css). tests/unit/ui/contrast.test.ts
 * holds every pair here at its threshold, in both palettes, so this table is
 * no longer the only place a failure would show.
 */
export const CONTRAST_PAIRS: readonly { fg: string; bg: string; use: string; large?: boolean }[] = [
  { fg: '--ink', bg: '--paper', use: 'body text on the page' },
  { fg: '--ink', bg: '--surface', use: 'body text on a card' },
  { fg: '--muted', bg: '--paper', use: 'every route’s subtitle' },
  { fg: '--muted', bg: '--surface', use: 'secondary text on a card' },
  { fg: '--lookup', bg: '--lookup-soft', use: 'the active nav pill, list badges' },
  { fg: '--new', bg: '--new-soft', use: 'the “new” badge' },
  { fg: '--practice', bg: '--practice-soft', use: 'the practice chip, the Practice tab' },
  { fg: '--ink', bg: '--practice-soft', use: 'ink on the practice tint' },
  { fg: '--warning', bg: '--warning-soft', use: 'the warning badge' },
  { fg: '--muted-on-tint', bg: '--lookup-soft', use: 'secondary text on the jade tint (a picked result)' },
  { fg: '--muted-on-tint', bg: '--new-soft', use: 'secondary text on the gold tint' },
  { fg: '--muted-on-tint', bg: '--practice-soft', use: 'secondary text on the vermillion tint' },
  { fg: '--muted-on-tint', bg: '--warning-soft', use: 'secondary text on the warning tint' },
  { fg: '--on-accent', bg: '--practice', use: 'text on the one primary action' },
  { fg: '--on-accent', bg: '--lookup', use: 'text on a Look up action' },
  { fg: '--lookup', bg: '--paper', use: 'the focus ring', large: true },
  { fg: '--skeleton', bg: '--surface', use: 'a loading placeholder', large: true },
];

/** sRGB relative luminance, per WCAG 2.x. */
function luminance(colour: string): number | null {
  const parts = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(colour);
  if (!parts) return null;
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(Number(parts[1])) +
    0.7152 * channel(Number(parts[2])) +
    0.0722 * channel(Number(parts[3]))
  );
}

function ContrastTable() {
  const [rows, setRows] = useState<{ use: string; label: string; ratio: number; ok: boolean }[]>([]);

  useEffect(() => {
    const read = (token: string): string => {
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    const measure = () =>
      setRows(
        CONTRAST_PAIRS.map((pair) => {
          const a = luminance(read(pair.fg));
          const b = luminance(read(pair.bg));
          const ratio = a === null || b === null ? 0 : (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          return {
            use: pair.use,
            label: `${pair.fg} on ${pair.bg}`,
            ratio,
            ok: ratio >= (pair.large ? 3 : 4.5),
          };
        }),
      );
    measure();
    // The theme control changes `data-theme`; re-measure when it does.
    const observer = new MutationObserver(measure);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return (
    <ul data-testid="gallery-contrast" className="flex flex-col gap-1 text-sm">
      {rows.map((row) => (
        <li
          key={row.label}
          data-testid="gallery-contrast-row"
          data-pass={row.ok ? 'true' : 'false'}
          className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1"
        >
          <span className="font-mono text-xs">{row.label}</span>
          <span className="text-xs text-muted">{row.use}</span>
          <span className={row.ok ? 'text-lookup' : 'text-warning'}>
            {row.ratio.toFixed(2)}:1 {row.ok ? 'PASS' : 'FAIL'}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ThemeControl() {
  const [theme, setTheme] = useState<string>('unset');
  const apply = (next: string) => {
    setTheme(next);
    if (next === 'unset') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
  };
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="gallery-theme">
      {['unset', 'light', 'dark', 'system'].map((value) => (
        <Button
          key={value}
          size="sm"
          variant={theme === value ? 'primary' : 'secondary'}
          data-testid={`gallery-theme-${value}`}
          onClick={() => apply(value)}
        >
          {value}
        </Button>
      ))}
    </div>
  );
}

/** One block, long enough that a hold has several characters to walk through. */
const SPEAKER_RUNS = [
  { text: '打算', pinyinNum: 'da3 suan4' },
  { text: '明天', pinyinNum: 'ming2 tian1' },
  { text: '去', pinyinNum: 'qu4' },
  { text: '北京', pinyinNum: 'Bei3 jing1' },
] as const;
const SPEAKER_TEXT = SPEAKER_RUNS.map((run) => run.text).join('');

export function Gallery() {
  // One provider for the life of the page: a new one per render would cancel
  // the sequence the learner is listening to on every state change.
  const [speakProvider] = useState(() => new GalleryTTSProvider());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [fieldValue, setFieldValue] = useState('');
  const [activeTab, setActiveTab] = useState('look-up');
  const [longShown, setLongShown] = useState(false);
  /**
   * One fake store, built once: `DictGate` subscribes to it, so a new instance
   * per render would drop the subscription on every keystroke elsewhere on the
   * page.
   */
  const [dictStore] = useState(() => new FakeDictStore());
  const [received, setReceived] = useState(0);

  return (
    <div data-testid="gallery" className="flex flex-col gap-8 pb-24">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Gallery</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">
          {GALLERY_MARKER}, plus the composite states that are otherwise only reachable by breaking
          something. Dev and <code className="font-mono">--mode e2e</code> builds only — a
          production bundle has no route here.
        </p>
        <div className="mt-3">
          <ThemeControl />
        </div>
      </header>

      <Section
        id="tokens"
        title="Tokens"
        note={
          <>
            Tier 2 only. <code className="font-mono">--practice-soft</code> is the one value
            product-decisions §11 did not settle; it is proposed here for the owner to confirm or
            replace, and it sits next to the two tints it was derived against.
          </>
        }
      >
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SWATCHES.map(({ token, role }) => (
            <li
              key={token}
              data-testid="gallery-swatch"
              data-token={token}
              className="flex items-center gap-3 rounded-[var(--r-sm)] border border-border p-2"
            >
              <span
                aria-hidden
                className="size-10 shrink-0 rounded-[var(--r-sm)] border border-border"
                style={{ background: `var(${token})` }}
              />
              <span className="min-w-0">
                <span className="block font-mono text-xs">{token}</span>
                <span className="block text-xs text-muted">{role}</span>
              </span>
            </li>
          ))}
        </ul>
        <Row label="the three soft tints as chips, side by side">
          <Chip tone="lookup">learning</Chip>
          <Chip tone="new">new</Chip>
          <Chip tone="practice">practice</Chip>
        </Row>
        {/* Spelled out rather than built from a template literal: the tokens
            test walks every `var(--…)` in app source and asserts the name is one
            tokens.css declares, and an interpolated step number leaves the guard
            reading a truncated name — a hole in it, not a clever loop. */}
        <Row label="measured contrast — two of these are the owner's call (HANDOFF.md, C0)">
          <ContrastTable />
        </Row>
        <Row label="radius scale — 12 / 16 / 24">
          {RADII.map(({ token, label }) => (
            <span
              key={token}
              className="flex size-16 items-center justify-center border border-border bg-surface font-mono text-xs"
              style={{ borderRadius: token }}
            >
              {label}
            </span>
          ))}
        </Row>
      </Section>

      <Section id="type" title="Type" note="Three families, each with a real fallback stack.">
        <p className="font-[family-name:var(--font-display)] text-3xl">Look it up in context</p>
        <p className="font-[family-name:var(--font-ui)] text-base">
          The interface text is DM Sans, or whatever the device has that is closest.
        </p>
        <p className="hanzi text-3xl" lang="zh-Hans">
          打算去中国学习中文
        </p>
      </Section>

      <Section id="buttons" title="Button">
        {(['primary', 'lookup', 'secondary', 'ghost'] as const).map((variant) => (
          <Row key={variant} label={`variant="${variant}"`}>
            {(['sm', 'md', 'lg'] as const).map((size) => (
              <Button key={size} variant={variant} size={size}>
                {size}
              </Button>
            ))}
            <Button variant={variant} disabled>
              disabled
            </Button>
          </Row>
        ))}
        <Row label='shape="grade" — the 2×2 bar C8 relabels'>
          <div className="grid w-full max-w-sm grid-cols-2 gap-2">
            <Button shape="grade" variant="secondary" sub="1 min">
              Forgot it
            </Button>
            <Button shape="grade" variant="secondary" sub="6 min">
              Barely remembered
            </Button>
            <Button shape="grade" variant="primary" sub="3 days">
              Got it
            </Button>
            <Button shape="grade" variant="secondary" sub="8 days">
              Instant
            </Button>
          </div>
        </Row>
      </Section>

      <Section id="card" title="Card, Badge, Chip" note="Cards are bordered, never shadowed.">
        <Card title="A card" aside={<Badge tone="lookup">HSK 1</Badge>}>
          <p className="text-sm">Body text on the raised surface.</p>
        </Card>
        <Row label="Badge tones">
          {(['neutral', 'accent', 'lookup', 'practice', 'new', 'warning'] as const).map((tone) => (
            <Badge key={tone} tone={tone}>
              {tone}
            </Badge>
          ))}
        </Row>
        <Row label="Chip tones">
          {(['neutral', 'lookup', 'practice', 'new', 'warning'] as const).map((tone) => (
            <Chip key={tone} tone={tone}>
              {tone}
            </Chip>
          ))}
        </Row>
      </Section>

      <Section id="form" title="Input and Field">
        <Field label="Plain field" help="Help text sits under the control.">
          {(props) => (
            <Input
              {...props}
              value={fieldValue}
              onChange={(event) => setFieldValue(event.target.value)}
              placeholder="Type something"
            />
          )}
        </Field>
        <Field label="Field with an error" error="That is not a word this dictionary has.">
          {(props) => <Input {...props} defaultValue="zzz" />}
        </Field>
      </Section>

      <Section id="states" title="EmptyState and Skeleton">
        <EmptyState title="No lists yet" action={<Button size="sm">Make one</Button>}>
          A list is a handful of words you want to see together.
        </EmptyState>
        <div className="flex flex-col gap-2">
          <Skeleton className="w-1/2" />
          <Skeleton />
          <Skeleton className="w-3/4" />
        </div>
      </Section>

      <Section
        id="sheet"
        title="Sheet"
        note="A bottom sheet at 390px — the lower two thirds, so the tapped character stays visible — and a side panel from 720px up, the wide shell&rsquo;s own breakpoint."
      >
        <div>
          <Button data-testid="gallery-open-sheet" onClick={() => setSheetOpen(true)}>
            Open the sheet
          </Button>
        </div>
        <Sheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title="打算"
          data-testid="gallery-sheet"
        >
          <p className="hanzi text-3xl" lang="zh-Hans">
            打算
          </p>
          <p className="mt-2 text-sm text-muted">dǎsuàn · to plan; to intend</p>
          <div className="mt-4 flex gap-2">
            <Button size="sm">Add</Button>
            <Button size="sm" variant="secondary">
              Mark known
            </Button>
          </div>
        </Sheet>
      </Section>

      <Section
        id="tabs"
        title="TabBar"
        note="Three tabs, bottom-anchored on a phone, safe-area aware. C7 mounts it for real."
      >
        <div className="overflow-hidden rounded-[var(--r-md)] border border-border">
          <TabBar
            items={TABS}
            active={activeTab}
            renderItem={(item, { active, className }) => (
              <button
                type="button"
                className={className}
                aria-current={active ? 'page' : undefined}
                data-testid={`gallery-tab-${item.key}`}
                onClick={() => setActiveTab(item.key)}
              >
                {item.label}
              </button>
            )}
          />
        </div>
      </Section>

      <Section
        id="dict-status"
        title="The dictionary's four states"
        note={
          <>
            Driven by a stubbed <code className="font-mono">DictStatus</code>; C4a drives them from{' '}
            <code className="font-mono">store.status</code>. The ids here are the ids C4a&rsquo;s
            specs assert. <code className="font-mono">ready</code> renders nothing, which is the
            point of it.
          </>
        }
      >
        {DICT_STATES.map(({ key, status }) => (
          <div key={key} data-testid={`dict-state-${key}`} className="flex flex-col gap-1">
            <p className="font-mono text-xs text-muted">{key}</p>
            <DictStatusView status={status} onStart={() => undefined} />
            {status.state === 'ready' ? (
              <p className="text-xs text-muted">(nothing — ready is the absence of a banner)</p>
            ) : null}
          </div>
        ))}
        {/* The native first-launch copy and its low-storage failure, which
            C1 names among the composite states and `ios.md` register #18 and
            `android.md` A5 both wait on. They carry their own ids for the same
            reason the web-side ones do: a shared `dict-status` id is not a
            stable hook, it is a collision. */}
        {ASSET_STATES.map(({ key, status }) => (
          <div key={key} data-testid={`dict-state-${key}`} className="flex flex-col gap-1">
            <p className="font-mono text-xs text-muted">{key}</p>
            <DictStatusView status={status} source="asset" onStart={() => undefined} />
          </div>
        ))}
      </Section>


      <Section
        id="passage"
        title="A reading passage, with per-character ruby"
        note={
          <>
            C3&rsquo;s criteria are about a <em>passage</em>, and nothing outside the reader renders
            one — C5b owns that file, so they are asserted here instead. The runs come from{' '}
            <code>segment()</code> over the demo paragraph and the readings from the dictionary; a
            unit test re-derives them. Each column overrides the setting rather than reading it, so
            all three states are on screen at once.
          </>
        }
      >
        <div className="flex flex-col gap-6 wide:flex-row">
          {PASSAGE_MODES.map(({ key, label, note }) => (
            <div key={key} data-testid={`passage-${key}`} className="min-w-0 flex-1">
              <p className="font-mono text-xs text-muted">
                {label} — {note}
              </p>
              <p className="mt-2 text-2xl leading-loose">
                <HanziText
                  runs={PASSAGE_200}
                  display={key}
                  // A tap has to do something, or `'tap'` cannot be reviewed:
                  // the reveal lives inside `<HanziText>` and only fires for a
                  // passage that takes a word handler. C4 hangs the real word
                  // sheet off this.
                  onWord={() => undefined}
                  data-testid={`passage-text-${key}`}
                />
              </p>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            data-testid="passage-long-show"
            onClick={() => setLongShown(true)}
          >
            Mount 500 characters
          </Button>
          <p className="text-xs text-muted">
            Mounted on demand, not on load: the layout cost C3 records is the cost of{' '}
            <em>mounting</em> one, and a passage already on the page cannot be timed.
          </p>
        </div>
        {longShown ? (
          <p className="text-2xl leading-loose" data-testid="passage-long">
            <HanziText runs={PASSAGE_500} display="always" data-testid="passage-text-long" />
          </p>
        ) : null}
      </Section>

      <Section
        id="dict-gate"
        title="The dictionary gate, driven by a real store"
        note={
          <>
            The row above is <code>DictStatusView</code> handed a literal. This one is
            <code> &lt;DictGate&gt; </code> subscribed to a <code>DictStore</code> whose status these
            buttons move — which is the claim C4a actually makes: that the gate re-renders from{' '}
            <code>subscribe()</code>, that a determinate bar&rsquo;s value moves, and that a retry
            reaches <code>open()</code>. A literal cannot fail any of those.
          </>
        }
      >
        <div className="flex flex-wrap gap-2" data-testid="dict-drive">
          <Button
            variant="secondary"
            size="sm"
            data-testid="drive-absent"
            onClick={() => {
              setReceived(0);
              dictStore.set({ state: 'absent' });
            }}
          >
            absent
          </Button>
          <Button
            variant="secondary"
            size="sm"
            data-testid="drive-preparing"
            onClick={() => {
              setReceived(0);
              dictStore.set({ state: 'preparing', received: 0, total: TOTAL });
            }}
          >
            preparing
          </Button>
          <Button
            variant="secondary"
            size="sm"
            data-testid="drive-advance"
            onClick={() => {
              const next = Math.min(TOTAL, received + TOTAL / 4);
              setReceived(next);
              dictStore.set({ state: 'preparing', received: next, total: TOTAL });
            }}
          >
            advance
          </Button>
          <Button
            variant="secondary"
            size="sm"
            data-testid="drive-ready"
            onClick={() => dictStore.set({ state: 'ready', version: '1.3.20251213' })}
          >
            ready
          </Button>
          {(['download', 'import', 'storage', 'corrupt'] as const).map((reason) => (
            <Button
              key={reason}
              variant="secondary"
              size="sm"
              data-testid={`drive-failed-${reason}`}
              onClick={() =>
                dictStore.set({ state: 'failed', reason, message: `a ${reason} failure` })
              }
            >
              failed: {reason}
            </Button>
          ))}
        </div>

        <div className="rounded-[var(--r-md)] border border-border p-3">
          <DictGate store={dictStore}>
            <p data-testid="dict-gate-children" className="text-sm text-muted">
              Ready is the state with no screen — this is what a lookup surface renders through.
            </p>
          </DictGate>
        </div>
      </Section>

      <Section
        id="speaker"
        title="The speaker, and hold to slow"
        note={
          <>
            Tap to read the block as one utterance; <strong>hold</strong> it (500 ms — both
            platforms&rsquo; own long-press default) to read it character by character at 0.6×,
            with each character lit as it plays. The <em>Slow</em> button beside it does the same
            thing from the keyboard, because a long press is not an accessible affordance on its
            own. The provider here is the gallery&rsquo;s own: it produces{' '}
            <strong>no audio</strong> — headless Chromium has no voices at all — and exists so the
            gesture, the timing and the lit character can be driven in a real browser.
          </>
        }
      >
        <div data-testid="gallery-speaker" className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <HanziText
              runs={SPEAKER_RUNS}
              display="always"
              className="text-3xl"
              data-testid="gallery-speaker-text"
              // Rule 3's third clause, demonstrable in a browser for the same
              // reason the hold is: the real adapter has no voice to speak with.
              speakOnTap
              speakProvider={speakProvider}
            />
            <SpeakControl text={SPEAKER_TEXT} provider={speakProvider} label={SPEAKER_TEXT} />
          </div>
        </div>
      </Section>

      <Section
        id="ask-states"
        title="The ask panel's three answer states"
        note="The happy path is the easy one; these three are what make the grounding promise visible. C7 builds the real panel against the same ids."
      >
        {ASK_STATES.map(({ key, state }) => (
          <div key={key} className="flex flex-col gap-1">
            <p className="font-mono text-xs text-muted">{key}</p>
            <AskStateSpecimen state={state} />
          </div>
        ))}
      </Section>
    </div>
  );
}
