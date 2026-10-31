# Kànjù 看剧

A Chrome extension for learning Mandarin from the shows you watch. It replaces the site's
subtitles with **sentence cards**: Chinese cues and English cues whose times overlap are joined,
so a sentence whose English was reordered across two cues reads as one. Words are split by
Tangram's segmenter (jieba's algorithm over CC-CEDICT), pinyin shows the tones as spoken
(不是 bú shì, 一个 yí ge), and every word opens a dictionary popover.

The design doc is the project's "Kànjù 看剧: design". This is milestone 1: YouTube, the local
pass, the card and the sidebar. The AI pass (word splits, meanings in context, English↔Chinese
alignment), the learning layer and the other four sites come next.

## Load it in Chrome

```bash
pnpm install
pnpm extension          # pnpm data (if missing) → the extension's dictionary → apps/extension/dist
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick
`apps/extension/dist`. Open a YouTube video that has a Chinese subtitle track.

After a code change, `pnpm -F extension build` and press the reload arrow on the extension's card.
`pnpm -F extension watch` rebuilds on save.

## Keys

| Key | Does |
|---|---|
| A / D | Previous / next sentence |
| R | Replay the sentence |
| P | Pinyin on/off |
| E | English on/off |
| H | Tone colours on/off |
| [ / ] | Slower / faster |
| S | Show / hide the sidebar |
| Esc | Close the word popover |

Click any word for its dictionary entry; the video pauses while the popover is open.

## How it fits together

| Path | What |
|---|---|
| `src/page/youtube.ts` | MAIN world. Watches the player's own signed timedtext requests and reads its caption list. |
| `src/content/adapters/` | One `SiteAdapter` per site: find the tracks, fetch both, wrap the player. |
| `src/core/` | Parsers (json3, WebVTT/SRT), sentence grouping, tone changes, the dictionary. No DOM, no `chrome.*`. |
| `src/background/` | Service worker. Holds the dictionary for every tab; the Claude key will live here too. |
| `src/ui/` | Preact card and sidebar, each in its own shadow root, sharing one store. |
| `scripts/build-dict.ts` | Cuts `public/dict.json` (simplified headwords, ~10 MB) from `data/dict.json`. |

`@/…` imports resolve into `apps/app`, which is how the extension shares `lib/dict/segment.ts` and
`lib/dict/pinyin.ts` with the app instead of copying them.

CC-CEDICT is CC BY-SA 4.0: `data/ATTRIBUTION.md` ships inside the extension and is linked from
the sidebar footer.
