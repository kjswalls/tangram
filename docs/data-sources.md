# Verified data sources (probed 2026-09-07 from the build container)

- CC-CEDICT: npm `cedict-json@1.3.20251213` (license CC-BY-SA-4.0). Tarball has `cedict.json`
  (16.5 MB) = JSON array of 124,188 entries shaped
  `{traditional, simplified, pinyin: "da3 suan4", english: ["to plan", ...]}`. Pinyin is
  numbered, space-separated, `u:` for ü. `english[]` may contain classifier notes like
  `"CL:個|个[ge4]"`. Install as a devDependency and read `node_modules/cedict-json/cedict.json`.
- HSK 3.0: `https://raw.githubusercontent.com/ivankra/hsk30/master/hsk30.csv` (MIT). 11,092 rows.
  Header: `ID,Simplified,Traditional,Pinyin,POS,Level,WebNo,WebPinyin,OCR,Variants,CEDICT`.
  `Level` is 1-6 or `7-9`. `Simplified` may contain `|`, `（）`, `…`, digits for variants — the
  `Variants` column and `hsk30-expanded.csv` (same dir) hold the clean forms; prefer
  `hsk30-expanded.csv` for matching. `CEDICT` column cross-references `trad|simp[pinyin]`.
- jieba frequencies: `https://raw.githubusercontent.com/fxsjy/jieba/master/jieba/dict.txt` (MIT).
  Lines `word freq pos`, ~350k lines, includes ASCII junk — keep CJK-only rows.
- Make Me a Hanzi: `https://raw.githubusercontent.com/skishore/makemeahanzi/master/dictionary.txt`.
  JSONL, one object per character: `{character, definition?, pinyin[], decomposition,
  radical, etymology?{type,hint}, matches}`. `decomposition` uses IDS chars (⿰⿱…) and `？`
  for unknown. License in repo `COPYING` (see probe output).
- Blocked from container: mdbg.net, kaikki.org, github.com HTML, api.github.com, tatoeba.
- Reachable: registry.npmjs.org, raw.githubusercontent.com.

# Pinned versions (checked on npm 2026-09-07; deliberately NOT always latest)
- next 16.3.4, react 19.2.8, react-dom 19.2.8, eslint-config-next 16.3.4
- typescript ^5.9 (latest on npm is 7.0.2 = the native port; do not use it tonight)
- vitest ^4 (5.0.0 shipped days ago; stay on 4 like anchor), @vitejs/plugin-react 6, jsdom 30
- zod ^3.25 (anchor is on 3; v4 API differs) — builders must not use zod 4 APIs
- ts-fsrs 5.4.2 (MIT), dexie 4.4.5 + dexie-react-hooks 4.4.0 (Apache-2.0), fake-indexeddb 6 (tests)
- pinyin-pro 3.29.3 (MIT) for tone-mark/number conversion and hanzi→pinyin
- @anthropic-ai/sdk 0.124.0 — Phase 4 builder must load the claude-api skill before writing against it
- zustand 5.0.15, tailwindcss 4.3.3 + @tailwindcss/postcss, clsx, lucide-react
- @playwright/test 1.63 — use executablePath /opt/pw-browsers/chromium, never 'playwright install'
- serwist 9.5.12 + @serwist/next for PWA (stretch only)
- eslint: anchor uses ^9.39.4 19.2.14
