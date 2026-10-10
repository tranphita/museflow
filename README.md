# Museta

**Museta** is a visual workflow extension for creating images and videos with your signed-in [Muse.ai](https://muse.ai) session. Connect nodes on a canvas, generate media, and arrange video clips on a timeline with background music.

[Tiếng Việt](README-vi.md)

**Quick install:** [Download Museta-extension.zip](https://github.com/tranphita/museflow/raw/refs/heads/main/downloads/Museta-extension.zip) · No npm install or build step required.

Museta is based on [MuseFlow / 26Flow](https://github.com/bynne2602/museflow) by bynne2602 and keeps its GPL-2.0-or-later license.

## Screenshots

The screenshots and demo video show the original MuseFlow interface; Museta's layout is the same.

### Demo video

[![Watch MuseFlow: create images, generate videos, and assemble scenes with Muse.ai](https://img.youtube.com/vi/w7mJwTJyzKw/maxresdefault.jpg)](https://www.youtube.com/watch?v=w7mJwTJyzKw)

### Workflow canvas and Muse.ai

![Workflow canvas connected to a Muse.ai session](docs/screenshots/26flow-workflow-canvas.png)

### Timeline

![Timeline preview playing a generated scene](docs/screenshots/26flow-timeline-preview.png)

![Timeline with ordered clips, thumbnails, and duration controls](docs/screenshots/26flow-timeline-editor.png)

## Features

The interface is in Vietnamese; technical terms such as workflow, node, prompt, timeline and worker stay in English. Button names below are quoted as they appear in the app.

- **Visual node canvas:** add, move, connect, multi-select, and arrange nodes. Hold **Alt** while dragging to copy nodes with their incoming connections; **Ctrl+Z** undoes the last canvas edit. Press **G** and drag to draw a group region; press **T** to add a text note. Pan, zoom, and use the context menu for node actions.
- **Prompt tools:** prompts, negative prompts, Text Append, and Text Merge (several text sources joined in connection order with a custom separator).
- **Image workflows:** image inputs, up to 8 reference images through a References node, image generation, resizing, and previews.
- **Video workflows:** video clips with optional end-frame continuity from the previous timeline clip, and **↻ Làm lại** to regenerate with stronger prompt adherence.
- **Output versions:** every Generate Image and Generate Video node keeps its last 8 results. Click a thumbnail under the node to switch back to an earlier version; the chosen version is kept (🔒) when you run the whole workflow.
- **Faster runs:** voiceovers generate alongside Muse, and **Cài đặt → Số tab Muse dùng cùng lúc** (1–3) spreads image and video requests over several Muse chat tabs. Videos chained with end-frame continuity still run in order.
- **Production queue:** queue episodes from any number of series and let worker tabs produce them overnight, each with its own Muse window. Unfinished episodes continue from their last finished step after a crash or restart.
- **Run progress:** a panel lists every step with its state, timing and failure reason; the running node pulses and the canvas follows it.
- **Reliable runs:** optionally retry a failed generation automatically, and keep running the rest of the workflow when one node fails (nodes that depend on it are skipped). Both options are in **Cài đặt**.
- **Timeline:** reorder clips, set durations, scrub and preview the sequence, add **background music** with a volume control, pick a **transition** between clips, and export WebM or MP4 (H.264). MP4 is assembled locally with the bundled FFmpeg engine.
- **Voiceover (TTS):** a Voiceover node reads text with a [tvoiceai](https://tvoiceai.com) voice; connect it to a Generate Video node's **giọng đọc** input and MP4 export mixes the narration into that clip (clip audio is lowered underneath, and the clip is extended if the line is longer). Scene scripts can use a `Lời thoại:` line per scene and a `GIỌNG ĐỌC:` voice id for the whole series. Paste your API key in **Cài đặt → Lồng tiếng**; it stays in this browser and is never saved into workflows.
- **Bilingual subtitles:** write dialogue as `Name: English | Tiếng Việt` and wrap the phrase to learn in `*...*`. With `PHỤ ĐỀ: song ngữ` in `_series.txt` (or the **Phụ đề** box on the Timeline), MP4 export burns each spoken line onto the video — English large, Vietnamese below, the marked phrase in yellow — timed to its voiceover. TTS reads only the English part.
- **Kịch bản → node:** turn a scene script into connected image/video nodes and an ordered timeline.
- **Workflow files:** **Xuất file** downloads a JSON file with media embedded where possible; **Mở file** restores it. Files saved by MuseFlow 0.5 still import.
- **Autosave:** the current workflow and its media are stored in the extension's browser storage. Workflows saved by MuseFlow are migrated automatically on first launch.

## Requirements

- A Chromium-based browser with Manifest V3 extension support.
- A signed-in Muse.ai session with its chat page open while generating.
- Muse.ai account features that support the requested generation. Aspect ratio, audio, and video availability depend on Muse.ai.

Museta talks to Muse.ai through a page bridge inside the extension. It does not use a separate backend, API keys, or Docker. Prompts and selected reference images are sent to Muse.ai when you run a generation. Timeline export runs locally.

## Install

1. Download [Museta-extension.zip](https://github.com/tranphita/museflow/raw/refs/heads/main/downloads/Museta-extension.zip) and extract it to a permanent folder.
2. Open `chrome://extensions` (or your browser's extensions page).
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the extracted folder that contains `manifest.json`.
5. Open Muse.ai, sign in, and open its chat page.
6. Click the **Museta** toolbar icon and check the Muse session status.

### Update

Replace the files with the new version, select **Reload** on the extensions page, then reload the Muse.ai tab so its bridge is refreshed. If you are upgrading from MuseFlow, remove the old MuseFlow extension after Museta has opened your workflow once.

## Quick start

1. Add a **Prompt** node and type your prompt.
2. Add a **Generate Image** or **Generate Video** node.
3. Drag the prompt's output to the generator's prompt input. Connect references if needed.
4. Click **▶ Chạy ảnh** / **▶ Chạy video** on the node, or **Chạy workflow** in the toolbar.
5. Connect results to a **Xem trước** node. For video, add clips to the **Timeline**, arrange them, optionally add **♪ Nhạc**, then preview or export.

For a scene script, use **Kịch bản → node**. Scene headings look like `CẢNH 1 (0:00–0:07): Scene title`, followed by `Prompt ảnh`, `Prompt video`, and an optional `Audio` field.

## Studio

The **Studio** tab lists your series and their episodes. Use **Nhập thư mục** to pick a series folder (`_series.txt`, `epXX.txt` episodes and a `characters/` folder); Museta builds each episode's workflow in the browser. Every episode row shows its scenes, length and dialogue lines, its status and last run, and has **Xếp hàng**, **Mở trong Canvas** and, once an MP4 exists, **Phát** and **Tải MP4**. **Xếp hàng cả bộ** adds the unfinished episodes of a series, and **Xếp hàng mọi bộ** in the sidebar adds them from every series, alternating between series. Choose the folder again with **Cập nhật từ thư mục** after editing scripts.

## Production queue

1. Queue episodes in the Studio.
2. Open **Sản xuất**, check **Cài đặt hàng đợi** (Số worker, Số lần thử mỗi tập, Nghỉ giữa các lượt gửi Muse, URL chat mới), then press **Bắt đầu**. Each worker opens one Muse window and one worker tab. Sign in to Muse in each window the first time and keep them open. Leave the Muse windows visible on screen, not minimized or fully covered by another window: Chrome slows down pages in hidden windows.
3. Leave Chrome running. The computer stays awake while the queue has work, and each episode starts in a fresh Muse chat. MP4 exports run one at a time.
4. Review in the morning: **Phát**, then **Duyệt** (the episode is marked **Xong** in the Studio), **Làm lại** (produce it again from the start) or **Mở trong Canvas** to fix single scenes. **Tải tất cả** saves the approved MP4s.
5. The queue pauses by itself when Muse runs out of credits, a worker window is signed out or closed, the tvoiceai key is missing or rejected, or three episodes in a row cannot reach Muse. Fix the cause and press **Tiếp tục**: unfinished episodes continue from their last finished step. Other failures retry after 1, 5 and 15 minutes; an episode that keeps failing, or that Muse refuses, moves to **Cần xử lý** with the reason.

## Consistency rules

Add a `LUẬT:` block to `_series.txt` with one line per character (and `Chung` for every scene), rules separated by `;` — for example `- Phi Ta: always wears black square glasses; no beard`. Each scene prompt carries the rules for the people in it as a **CONTINUITY RULES** section. The Studio checks every episode before you run it and flags scenes that contradict a rule (removing a must-keep item or adding a banned one), speakers or named characters missing from the scene's `Nhân vật` line, dialogue longer than its scene, and scenes over 10 seconds.

## Short films with consistent characters

Add a cast to your scene script and use **Kịch bản → node** (see the [sample script](docs/sample-film-script.txt)):

```
PHONG CÁCH: live-action, photorealistic, natural light, no animation, no 3D

NHÂN VẬT:
- Linh: 20-year-old woman, short black bob, mustard jacket
- Mun: black cat, green eyes, red collar

CẢNH 1 (0:00–0:06): Meeting
Nhân vật: Linh, Mun
Prompt ảnh: ...
Prompt video: ...
```

Museta then creates a character reference sheet for each character and connects it to every scene that features them (from the scene's `Nhân vật:` line, or from names mentioned in its prompts). Each scene prompt gets the character descriptions, the film style, and a **CHARACTER LOCK** instruction. Later clips use end-frame continuity and are asked to end on a steady frame that leads into the next shot, and the timeline defaults to a 0.5 s crossfade. Change the transition (Cut, Crossfade, Fade through black, Dissolve, Slide left) and its length with the **⇄** control in the timeline dock; transitions are applied in MP4 export.

To get a file for **Mở file** instead of pasting the script, run `npm run script-to-workflow -- my-script.txt` to write `my-script.workflow.json` (example: [docs/sample-film.workflow.json](docs/sample-film.workflow.json)).

Tip: run the character nodes first, pick the best version from the **Phiên bản** strip (or tick **🔒 Giữ kết quả này**), then run the whole workflow. Kept nodes are skipped by Run workflow; their own Run button still regenerates them.

## Series with recurring characters

[series/](series/README.md) holds two ready-made series (an English-learning series and a daily gym vlog). Each has a shared `_series.txt` (style and cast), episode scripts `epXX.txt`, and a `characters/` folder for approved character images so every episode reuses the same faces. Build all episode workflows with `npm run series -- series/<name>`.

## View Museta and Muse.ai side by side

Drag the Museta tab into its own window, then press **Windows + Left Arrow** on it and **Windows + Right Arrow** on the Muse.ai window. Keep both open to follow the running node and Muse's response.

## Troubleshooting

- **Muse session is unavailable:** sign in to Muse.ai, keep its chat page open, then reload Museta and the Muse.ai tab.
- **"Muse page changed" in the status bar:** Muse updated its interface. Open **Cài đặt → Kiểm tra phiên Muse** to see which part of the page Museta can no longer find. All page hooks live in [`bridge/muse-ui.js`](bridge/muse-ui.js), so a fix is usually a one-line selector change there.
- **Muse declines a scene:** Museta detects refusals (including Vietnamese replies) and retries that scene once with a close, safe alternative prompt. Muse.ai still decides whether the result can be generated.
- **Timeline export fails:** reload the extension and try again. MP4 uses the bundled FFmpeg; WebM uses the browser's `MediaRecorder`.
- **Output differs from requested settings:** Muse.ai controls the generated media and may not always honor the requested ratio, audio, or video options.

## Data and permissions

Workflows and media are kept in extension storage on your device; media that is no longer referenced is cleaned up automatically. The extension requests storage, tab, and scripting access to save workflows and communicate with the Muse.ai tab. There is no Museta account or server.

## Development

No build step: the extension loads `src/main.js` as an ES module. Node.js 22+ is only needed for checks.

```sh
npm test          # unit tests (node:test, no dependencies)
npm run lint      # eslint via npx
npm run format    # prettier via npx
npm run package   # build downloads/Museta-extension.zip from the committed HEAD
```

| Path | Contents |
| --- | --- |
| `src/core/` | DOM-free logic: graph resolution and ordering, scene-script parser, prompt building, output history, FFmpeg argument plans |
| `src/app/` | UI and browser integration: canvas rendering, connections, timeline and export, runner, persistence, Muse tab messaging |
| `bridge/` | Content scripts injected into Muse.ai: page hooks (`muse-ui.js`), refusal detection, and the generation bridge |
| `tests/unit/` | Unit tests for `src/core` and the refusal detector |
| `tests/smoke/` | Browser smoke tests with a `chrome.*` stub, a fake Muse page, and real FFmpeg export runs (with and without bilingual subtitles) |

To run the smoke tests, serve the repository root (for example `python -m http.server 8765`) and run the scripts in `tests/smoke/` with Playwright.

## License

Museta is licensed under the [GNU General Public License v2.0 or later](LICENSE), matching the bundled FFmpeg core. The FFmpeg JavaScript wrapper remains MIT-licensed. See [third-party notices](THIRD_PARTY_NOTICES.md).
