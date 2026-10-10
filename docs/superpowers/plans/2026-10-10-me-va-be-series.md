# Series "Mẹ & Mia" + phụ đề song ngữ — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Burn phụ đề song ngữ Anh–Việt vào MP4 xuất từ Timeline và tạo bộ phim `series/me-va-be/` (5 tập thử) dùng tính năng đó.

**Architecture:** Kịch bản ghi `English | Tiếng Việt` với cụm `*...*` tô vàng. `parseVoiceLines` tách ra `subtitle: { en, vi }`, `film-graph` lưu vào node Voiceover. Khi xuất MP4, `subtitle-plan.js` (thuần) tính thời điểm từng câu từ cùng lịch `scheduleVoices`/`xfade` và dựng file `.ass`; `buildEncodeArgs` thêm filter `subtitles` (libass) với font Be Vietnam Pro ExtraBold nạp vào FS của ffmpeg.wasm.

**Tech Stack:** JS ES modules (extension MV3, không build step), `node --test`, ffmpeg.wasm 0.12.10 (có libass/freetype/fribidi/harfbuzz, không fontconfig), Playwright cho smoke test.

**Spec:** `docs/superpowers/specs/2026-10-10-me-va-be-series-design.md`

## Global Constraints

- Không runtime dependency, không build step; font nằm ở `vendor/fonts/BeVietnamPro-ExtraBold.ttf` (OFL 1.1, `licenses/OFL-1.1.txt`).
- Tên font trong `.ass`: `Be Vietnam Pro ExtraBold`, `Bold = 0` (name ID 1 của file; đã kiểm chứng libass chọn đúng font qua `fontsdir=/fonts`).
- Không có phụ đề → lệnh FFmpeg giữ nguyên như hiện tại (test cũ không đổi).
- Bộ không ghi `PHỤ ĐỀ: song ngữ` → không phụ đề, không cảnh báo mới.
- Màu tô vàng `#FFD84D` (ASS `&H4DD8FF&`), dòng VI `#FFF5E6` (ASS `&HE6F5FF&`).
- Chuỗi giao diện tiếng Việt, thuật ngữ kỹ thuật giữ tiếng Anh; không viết comment mô tả code.

## Review Focus

- Text có `{`, `}` hoặc `\` (người viết gõ nhầm) → phải hiện nguyên văn, không thành tag ASS → test escape trong Task 2.
- Workflow cũ / node Voiceover sửa tay không có `data.subtitle` → phụ đề dùng `data.text`, chỉ dòng EN → test trong Task 3.
- Hai câu thoại sát nhau → câu trước kết thúc trước khi câu sau bắt đầu, không chồng hai phụ đề → test trong Task 2.
- Câu thoại vượt quá cuối timeline (clip bị cắt 60 s) → event bị cắt ở cuối, không âm/không rỗng → test trong Task 2.
- `*` lẻ trong câu → hiện dấu `*` như ký tự thường, TTS vẫn đọc được, `script-check` cảnh báo → test trong Task 1 và Task 4.

---

### Task 1: Tách vế dịch và cụm tô vàng trong `parseVoiceLines`

**Files:**
- Modify: `src/core/scene-script.js`
- Test: `tests/unit/subtitles.test.js` (mới)

**Interfaces:**
- Produces: `parseVoiceLines(text, names)` → `{ speaker, text, subtitle? }[]`; `subtitle = { en, vi }` (giữ `*`) chỉ có khi dòng chứa ` | ` hoặc cặp `*...*`; `text` luôn là chuỗi sạch cho TTS (bỏ `*`, bỏ vế VI).
- Produces: `parseSubtitleMode(text)` → `'bilingual' | 'off'` từ `PHỤ ĐỀ:` / `SUBTITLES:` trong phần đầu kịch bản.
- Produces: `stripHighlights(text)` → bỏ cặp `*...*`, giữ `*` lẻ.

- [ ] Step 1: test — dòng `- Mommy: Say *Can I have milk?* | Con nói *Con xin sữa ạ?*` → `{ speaker: 'Mommy', text: 'Say Can I have milk?', subtitle: { en: 'Say *Can I have milk?*', vi: 'Con nói *Con xin sữa ạ?*' } }`; dòng không markup giữ đúng shape cũ `{ speaker, text }`; `a|b` (không khoảng trắng) không tách; `*` lẻ giữ nguyên trong `text`; dòng nối không người nói nối cả `subtitle.en`/`vi`; `parseSubtitleMode('PHỤ ĐỀ: song ngữ\n\nCẢNH 1 …') === 'bilingual'`, `'SUBTITLES: bilingual'` cũng vậy, thiếu dòng → `'off'`.
- [ ] Step 2: `npm test` → FAIL (`parseSubtitleMode` chưa export).
- [ ] Step 3: implement:

```js
const TRANSLATION_SPLIT = /\s+\|\s+/;
const HIGHLIGHT = /\*([^*\n]+)\*/g;
export const stripHighlights = text => text.replace(HIGHLIGHT, '$1');

function bilingual(raw) {
  const split = TRANSLATION_SPLIT.exec(raw);
  const en = (split ? raw.slice(0, split.index) : raw).trim(),
    vi = split ? raw.slice(split.index + split[0].length).trim() : '';
  const marked = Boolean(split) || new RegExp(HIGHLIGHT.source).test(raw);
  return { text: stripHighlights(en), ...(marked ? { subtitle: { en, vi } } : {}) };
}

export function parseSubtitleMode(text) {
  const value = /^\s*(?:PHỤ\s+ĐỀ|SUBTITLES?)\s*:\s*(.+?)\s*$/im.exec(scriptPreamble(text))?.[1] || '';
  return /song\s*ngữ|bilingual/i.test(value) ? 'bilingual' : 'off';
}
```

`parseVoiceLines` áp `bilingual(unquote(...))` cho mỗi dòng; khi nối hai dòng không người nói, nối `text` và nếu một trong hai có `subtitle` thì nối `en`/`vi` (dòng thiếu dùng `{ en: text, vi: '' }`).
- [ ] Step 4: `npm test` → PASS (cả test cũ ở `voiceover.test.js`).
- [ ] Step 5: commit `Parse bilingual dialogue and highlighted phrases`.

### Task 2: `src/core/subtitle-plan.js` — lịch phụ đề và file `.ass`

**Files:**
- Create: `src/core/subtitle-plan.js`
- Test: `tests/unit/subtitles.test.js`

**Interfaces:**
- Consumes: `normalizeTransition(transition, durations)` từ `ffmpeg-plan.js` (`{ type, duration }`, `duration = 0` khi `cut`).
- Produces: `buildSubtitleEvents({ clips, transition })` → `{ start, end, en, vi }[]`, `clips = [{ duration, voices: [{ offset, duration, en, vi }] }]`.
- Produces: `buildAss({ events, width, height })` → string.
- Produces: `SUBTITLE_FONT = { file: 'BeVietnamPro-ExtraBold.ttf', name: 'Be Vietnam Pro ExtraBold' }`.

- [ ] Step 1: test —
  - hai clip 6 s cắt thẳng, voice ở clip 2 offset 0.2 dur 2 → event `start 6.2`, `end 8.45`;
  - `xfade` 0.5 s → clip 2 bắt đầu ở `5.5`;
  - hai voice cách 0.35 s → `end` câu 1 = `start` câu 2 (không chồng);
  - voice vượt cuối timeline → `end` = tổng thời lượng; voice bắt đầu sau cuối → bỏ;
  - voice `en` rỗng → bỏ;
  - `buildAss` chứa `PlayResX: 720`, `PlayResY: 1280`, `Dialogue: 0,0:00:06.20,0:00:08.45,…`, `{\c&H4DD8FF&}Can I{\c&HFFFFFF&}`, `\N` trước dòng VI, VI không có thì không có `\N`; text `a{b}\c` ra `a\{b\}\\c` không sinh tag; xuống dòng trong text thành khoảng trắng.
- [ ] Step 2: `npm test` → FAIL (module chưa có).
- [ ] Step 3: implement (pure):

```js
import { normalizeTransition } from './ffmpeg-plan.js';

export const SUBTITLE_FONT = { file: 'BeVietnamPro-ExtraBold.ttf', name: 'Be Vietnam Pro ExtraBold' };
const LINGER_SECONDS = 0.25;
const COLORS = { en: '&HFFFFFF&', vi: '&HE6F5FF&', highlight: '&H4DD8FF&' };

export function buildSubtitleEvents({ clips, transition = null }) { … clipStart = Σ duration − blend × i … }
const escapeAss = text => text.replace(/\\/g, '\\\\').replace(/[{}]/g, m => `\\${m}`).replace(/\s*\r?\n\s*/g, ' ');
const paint = (text, base) => escapeAss(text).replace(/\*([^*]+)\*/g, `{\\c${COLORS.highlight}}$1{\\c${base}}`);
const assTime = seconds => … 'H:MM:SS.cc' …
export function buildAss({ events, width, height }) { … style EN = round(height*0.052), VI = round(height*0.038), outline = round(size*0.1), MarginV = round(height*0.22), MarginL/R = round(width*0.07) … }
```

Ghi chú escape: `\\` (backslash ASS) phải escape trước, rồi `{`/`}`; `paint` chạy sau escape nên `*` không bị ảnh hưởng.
- [ ] Step 4: `npm test` → PASS.
- [ ] Step 5: commit `Build bilingual ASS subtitles from the voice schedule`.

### Task 3: Nối phụ đề vào graph và xuất MP4

**Files:**
- Modify: `src/core/film-graph.js` (Voiceover `data.subtitle`, Timeline `data.subtitles`)
- Modify: `src/core/ffmpeg-plan.js` (`buildEncodeArgs({ …, subtitles })`, `canJoinWithoutReencode(…, { hasSubtitles })`)
- Modify: `src/app/timeline-export.js` (thu `en/vi/duration`, ghi font + `/subs.ass`)
- Modify: `app.html`, `src/app/timeline.js` (checkbox `#timelineSubtitles`)
- Test: `tests/unit/subtitles.test.js`

**Interfaces:**
- Consumes: Task 1 `subtitle`, `parseSubtitleMode`; Task 2 `buildSubtitleEvents`, `buildAss`, `SUBTITLE_FONT`.
- Produces: `voiceSubtitle(nodeData)` (trong `subtitle-plan.js`) → `{ en, vi }` (fallback `{ en: data.text, vi: '' }`).
- Produces: `buildEncodeArgs({ …, subtitles: { path, fontsDir } | null })` → khi có: filter `[outv]subtitles=filename=/subs.ass:fontsdir=/fonts[subv]` và map `[subv]`.

- [ ] Step 1: test — `workflowFromScript` với `PHỤ ĐỀ: song ngữ` ghi `timeline.data.subtitles === 'bilingual'`, Voiceover có `data.subtitle.en` giữ `*` và `data.text` sạch; không có dòng PHỤ ĐỀ thì không có trường `subtitles`; `voiceSubtitle({ text: 'Hi' })` → `{ en: 'Hi', vi: '' }`; `buildEncodeArgs` có `subtitles` → filter chứa `subtitles=filename=/subs.ass:fontsdir=/fonts[subv]` và `-map [subv]`; không có → args giống hệt lần gọi không truyền `subtitles`; `canJoinWithoutReencode(clips, { hasSubtitles: true }) === false`.
- [ ] Step 2: `npm test` → FAIL.
- [ ] Step 3: implement; trong `timeline-export.js` giữ `{ path, offset, duration, ...voiceSubtitle(node.data) }` cho từng voice; sau khi nạp voice, nếu `node.data.subtitles === 'bilingual'` thì dựng events từ `clipInfo` (duration đã kéo dài) + `node.data.transition`; có event thì `createDir('/fonts')`, ghi font fetch từ `chrome.runtime.getURL('vendor/fonts/…')`, ghi `/subs.ass`; lỗi → `throw new Error('Không dựng được phụ đề: …')`. Checkbox `#timelineSubtitles` trong `.timeline-dock-actions` cạnh chuyển cảnh, đồng bộ trong hàm sync transition, onchange ghi `'bilingual'`/`'off'`.
- [ ] Step 4: `npm test` → PASS; `npm run lint` sạch.
- [ ] Step 5: smoke thật: `tests/smoke/export-e2e.js` thêm voice có `subtitle` + `subtitles: 'bilingual'`, xuất MP4 bằng ffmpeg.wasm, log có `Loading font file '/fonts/BeVietnamPro-ExtraBold.ttf'` và file MP4 > 0 byte.
- [ ] Step 6: commit `Burn bilingual subtitles into MP4 exports`.

### Task 4: Cảnh báo phụ đề trong `script-check`

**Files:**
- Modify: `src/core/script-check.js`
- Test: `tests/unit/script-check.test.js`

**Interfaces:**
- Consumes: `parseSubtitleMode`, `subtitle` của Task 1.

- [ ] Step 1: test — với `PHỤ ĐỀ: song ngữ`: dòng thiếu ` | ` → warn "thiếu phần dịch tiếng Việt"; `*` lẻ → warn "dấu * chưa đóng"; số cụm `*…*` hai vế khác nhau → warn; vế EN > 70 ký tự (sau bỏ `*`) → warn "quá dài"; không bật phụ đề → không có các warn này.
- [ ] Step 2: FAIL. Step 3: implement trong vòng lặp `lines` của `checkEpisode`. Step 4: PASS.
- [ ] Step 5: commit `Check bilingual dialogue lines in scripts`.

### Task 5: Bộ phim `series/me-va-be/` + tài liệu + font license

**Files:**
- Create: `series/me-va-be/_series.txt`, `ep01-bua-sang.txt` … `ep05-gio-di-ngu.txt`, `series/me-va-be/characters/.gitkeep`
- Modify: `series/README.md`, `README.md`, `README-vi.md`, `THIRD_PARTY_NOTICES.md`
- Add: `vendor/fonts/BeVietnamPro-ExtraBold.ttf`, `licenses/OFL-1.1.txt`

- [ ] Step 1: viết `_series.txt` đúng spec mục 6 (PHONG CÁCH, TRÁNH, PHỤ ĐỀ, GIỌNG ĐỌC Mommy/Mia, LUẬT, NHÂN VẬT).
- [ ] Step 2: viết 5 tập, mỗi tập 7 cảnh theo format spec (Hook → Dạy → Luyện 1 → Luyện 2 → Twist → Ôn → Your turn), mỗi cảnh có `Nhân vật`, `Prompt ảnh`, `Prompt video`, `Audio: chỉ tiếng môi trường nhẹ, không lời thoại, không nhạc`, `Lời thoại` dạng `Tên: EN | VI` với cụm `*…*`.
- [ ] Step 3: `npm run series -- series/me-va-be` → không có lỗi `error`; sửa mọi warn có thể sửa.
- [ ] Step 4: tài liệu: mục "Phụ đề song ngữ" trong `series/README.md`, bảng bộ phim thêm dòng; README/README-vi một dòng tính năng; THIRD_PARTY_NOTICES thêm Be Vietnam Pro (OFL).
- [ ] Step 5: `npm test`, `npm run lint`; commit `Add the Mommy & Mia English series`; rebuild ZIP `npm run package` + commit `Rebuild Museta extension ZIP`.
