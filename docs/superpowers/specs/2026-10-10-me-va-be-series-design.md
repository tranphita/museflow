# Series "Mẹ & Mia" + phụ đề song ngữ — thiết kế

Series short video dạy tiếng Anh cho trẻ tiểu học: hai nhân vật 3D (mẹ và con gái Mia) giữ cố định qua mọi tập, thoại tiếng Anh bằng TTS, phụ đề song ngữ Anh–Việt gắn sẵn vào MP4.

## Mục tiêu

- Bấm **Xếp hàng cả bộ** trong Studio là ra MP4 hoàn chỉnh, đăng thẳng TikTok / YouTube Shorts / Reels, không qua CapCut.
- Nhân vật nhận ra ngay giữa các tập: cùng gương mặt, kiểu tóc, trang phục, phụ kiện nhận dạng.
- Đợt đầu: **5 tập thử** để chốt nhân vật, giọng, phụ đề; đạt rồi mới viết Season 1.
- Người xem: trẻ tiểu học (6–12 tuổi) và bố mẹ Việt. Mỗi tập dạy **một mẫu câu** dùng được ngay trong đời sống.

Ngoài phạm vi: tự dịch bằng máy, file `.srt` rời, phụ đề cho bộ `hoc-tieng-anh` / `gym-idol` (vẫn tắt), khớp khẩu hình với TTS, đăng bài tự động.

## Ràng buộc từ code hiện tại

- `vendor/ffmpeg/ffmpeg-core.wasm` đã build kèm `libass`, `freetype`, `fribidi`, `harfbuzz` và filter `subtitles` — burn-in chạy được trên máy, không cần backend.
- Thời điểm mỗi câu thoại đã biết lúc xuất: `scheduleVoices(durations)` trả offset trong clip, `clipLengthForVoices` kéo dài clip, `buildEncodeArgs` ghép clip bằng `concat` hoặc `xfade` với offset `Σ duration − blend × i`.
- `parseVoiceLines` trả `{ speaker, text }`; `film-graph.js` tạo một node Voiceover / dòng với `data.text` là thứ TTS đọc.
- Luật hiện tại của các bộ cấm "chữ hay phụ đề trên hình" — vẫn đúng: phụ đề chỉ do bước xuất thêm vào, hình từ Muse không bao giờ có chữ.
- Có voiceover thì `canJoinWithoutReencode` đã trả `false`; phụ đề cũng bắt buộc encode lại.

## 1. Cú pháp kịch bản

Mỗi dòng thoại: `Tên: tiếng Anh | tiếng Việt`. Cụm mẫu câu cần học bọc trong `*...*` ở cả hai vế.

```
Lời thoại:
- Mommy: When you want something, say *Can I have some milk?* | Khi muốn xin gì, con nói *Con uống sữa được không ạ?*
- Mia: *Can I have some* pancakes, please? | *Con ăn* bánh kếp *được không ạ*?
```

- Tách tại ` | ` **đầu tiên** (có khoảng trắng hai bên). Không có ` | ` → `translation = ''`.
- TTS đọc vế tiếng Anh sau khi bỏ dấu `*`. Vế tiếng Việt chỉ dùng cho phụ đề.
- `*` không khép cặp → coi là ký tự thường, `script-check` cảnh báo.

`parseVoiceLines` trả thêm trường: `{ speaker, text, translation, display: { en, vi } }` trong đó `text` là chuỗi sạch cho TTS, `display.en` / `display.vi` giữ dấu `*` để dựng phụ đề. Dòng nối (không có tên người nói) nối cả `text` lẫn `translation`.

## 2. Bật phụ đề

- `_series.txt`: dòng `PHỤ ĐỀ: song ngữ` (`parseSubtitleMode(text) → 'bilingual' | 'off'`, mặc định `off`; chấp nhận cả `SUBTITLES: bilingual`).
- `film-graph.js` ghi `subtitles: 'bilingual'` vào `timeline.data` và `subtitle: { en, vi }` vào `data` của từng node Voiceover.
- Node Timeline có ô **Phụ đề** (bật/tắt) cạnh nút **⇩ Xuất**; mặc định theo `timeline.data.subtitles`. Workflow cũ không có trường này → tắt.

## 3. Dựng phụ đề (`src/core/subtitle-plan.js`, thuần, có unit test)

```
buildSubtitleEvents({ clips, transition }) → [{ start, end, en, vi }]
  clips: [{ duration, voices: [{ offset, duration, en, vi }] }]
buildAss({ events, width, height }) → string (nội dung file .ass)
```

- **Thời điểm:** `clipStart[i] = Σ_{k<i} duration[k] − blend × i` (blend = 0 khi cắt cứng, cùng công thức với `xfade`). `start = clipStart + voice.offset`, `end = start + voice.duration + 0.25`, cắt ở `start` của câu kế tiếp và ở cuối timeline. Voice không có câu chữ (`en` rỗng) thì bỏ qua.
- **Bố cục** (theo `PlayResX/PlayResY` = khung xuất thật):
  - Dòng EN: font tròn đậm, cỡ ≈ 5,2% chiều cao, chữ trắng, viền đen 0,35× cỡ chữ, bóng nhẹ.
  - Dòng VI ngay dưới: cỡ ≈ 3,8% chiều cao, chữ trắng ngà, viền đen.
  - Cụm `*...*` tô vàng `#FFD84D` ở cả hai dòng (`{\c&H4DD8FF&}…{\r}`).
  - Neo giữa dưới (`\an2`), `MarginV` = 22% chiều cao để tránh caption và nút của TikTok/Shorts; lề trái/phải 7% chiều rộng, libass tự xuống dòng.
- **Font:** bundle `vendor/fonts/BeVietnamPro-ExtraBold.ttf` (SIL OFL, thiết kế cho tiếng Việt; đã kiểm chứng libass trong ffmpeg.wasm nạp qua `fontsdir`) và ghi vào `licenses/` + `THIRD_PARTY_NOTICES.md`. Escape `{`, `}`, `\` và xuống dòng trong text trước khi ghi vào `.ass`.

## 4. Tích hợp vào xuất MP4

- `loadClipVoiceovers` giữ thêm `en`, `vi`, `duration` của từng voice trong `clipInfo[index].voices`.
- Khi phụ đề bật và có ít nhất một event: ghi `/subs.ass` và `/fonts/BeVietnamPro-ExtraBold.ttf` vào FS của FFmpeg.
- `buildEncodeArgs({ …, subtitlesPath })`: nếu có thì thêm `[outv]subtitles=/subs.ass:fontsdir=/fonts[subv]` và map `[subv]`; nếu không thì giữ nguyên lệnh hiện tại (byte-for-byte, test cũ không đổi).
- `canJoinWithoutReencode(clipInfo, { …, hasSubtitles })` trả `false` khi có phụ đề.
- Lỗi font/ass → báo lỗi xuất rõ ràng ("Không dựng được phụ đề: …"), không lặng lẽ xuất bản không phụ đề.

## 5. Kiểm tra kịch bản (`script-check.js`)

Chỉ khi bộ bật `PHỤ ĐỀ: song ngữ`:

- dòng thoại thiếu vế tiếng Việt;
- `*` không khép cặp, hoặc số cụm `*...*` ở hai vế khác nhau;
- vế tiếng Anh dài hơn 70 ký tự (quá 2 dòng trên màn hình dọc) — gợi ý tách câu.

## 6. Bộ phim `series/me-va-be/`

### `_series.txt`

- `TÊN BỘ: Mẹ & Mia học tiếng Anh`
- `PHONG CÁCH`: hoạt hình 3D kiểu phim Pixar, nhân vật tỉ lệ hoạt hình dễ thương, da mịn, mắt to biểu cảm, ánh sáng mềm buổi sáng, màu pastel ấm, bối cảnh căn hộ hiện đại ấm cúng, khung dọc 9:16, không chữ hay phụ đề trên hình.
- `TRÁNH`: phong cách người thật, anime 2D, biến dạng mặt, đổi kiểu tóc, đổi trang phục, thêm người lạ, chữ/logo trên hình, ngón tay dị dạng.
- `PHỤ ĐỀ: song ngữ`
- `GIỌNG ĐỌC Mommy: sEqCT3Hajd9XHgxcM3e2cL`, `GIỌNG ĐỌC Mia: 7HLX11t8HSEC9wB1DxtZD9`, `GIỌNG ĐỌC` mặc định = giọng Mommy.

### Nhân vật

- **Mommy** (mẹ Mai): phụ nữ Việt ~32 tuổi, nhân vật 3D, gương mặt trái xoan hiền, mắt nâu to, tóc đen dài ngang vai buộc nửa đầu bằng kẹp tóc màu vàng, áo len mỏng màu vàng mù tạt cổ tròn, quần jean xanh nhạt, bông tai tròn nhỏ màu vàng.
- **Mia**: bé gái Việt 10 tuổi, nhân vật 3D, mắt to tròn lanh lợi, má hồng, tóc đen dài buộc đuôi ngựa cao bằng dây buộc tóc nơ đỏ, mái bằng, áo cardigan xanh mint ngoài áo thun trắng, chân váy jean, giày sneaker trắng viền đỏ, đồng hồ điện tử dây màu cam ở tay trái.

### LUẬT

- Mommy: luôn có kẹp tóc vàng và tóc buộc nửa đầu; áo len vàng mù tạt trừ khi cảnh ghi rõ trang phục khác; không đeo kính.
- Mia: luôn buộc đuôi ngựa cao với nơ đỏ và để mái bằng; cardigan xanh mint ngoài áo thun trắng trừ khi cảnh ghi rõ trang phục khác (đồ ngủ ở tập giờ đi ngủ); đồng hồ cam ở tay trái; không đeo kính.
- Chung: chỉ người ở dòng Nhân vật xuất hiện rõ mặt; không chữ, logo, phụ đề hay watermark trên hình; tay đủ năm ngón; giữ phong cách 3D Pixar ở mọi cảnh.

### Khoá nhân vật

1. Build workflow ep01 khi `characters/` còn trống → node "Character: Mommy" / "Character: Mia" tạo ảnh 3D.
2. Chạy lại tới khi ưng, chọn bản đẹp nhất; tạo thêm ảnh góc 3/4 và toàn thân.
3. Lưu `characters/Mommy.png`, `Mommy-2.png`, `Mommy-3.png`, `Mia.png`, `Mia-2.png`, `Mia-3.png`; build lại cả bộ. Từ đây mọi tập dùng ảnh khoá + LUẬT.

### Format một tập (~50 giây, 7 cảnh × 7 giây)

| Cảnh | Nhịp | Nội dung |
|---|---|---|
| 1 | Hook | Mia gặp tình huống, nói sai hoặc lúng túng |
| 2 | Dạy | Mommy dạy mẫu câu (tô vàng) |
| 3 | Luyện 1 | Mia dùng mẫu câu, thay một từ |
| 4 | Luyện 2 | Mia dùng tiếp với từ khác, Mommy đáp lại |
| 5 | Twist | Một tình huống bất ngờ dễ thương / hài nhẹ |
| 6 | Ôn | Mommy: "Today's phrase is…" |
| 7 | Your turn | Mia: "Your turn! Say it with me…" nói chậm, cảnh dài hơn ~1,5 giây để người xem nói theo |

Dòng `Audio:` mọi cảnh: "chỉ tiếng môi trường nhẹ, không lời thoại, không nhạc" — để Muse không tự tạo giọng chồng lên TTS.

### 5 tập thử

| Tập | Bối cảnh | Mẫu câu |
|---|---|---|
| ep01 | Bữa sáng | *Can I have some…?* |
| ep02 | Chuẩn bị đi học | *Where is my…?* |
| ep03 | Siêu thị | *How much is this?* |
| ep04 | Công viên | *Can I play with you?* |
| ep05 | Giờ đi ngủ | *I feel…* |

## 7. Cấu trúc code

| File | Thay đổi |
|---|---|
| `src/core/scene-script.js` | `parseVoiceLines` tách vế dịch và cụm `*...*`; `parseSubtitleMode` |
| `src/core/subtitle-plan.js` | Mới: `buildSubtitleEvents`, `buildAss`, escape |
| `src/core/ffmpeg-plan.js` | `subtitlesPath` trong `buildEncodeArgs`; `hasSubtitles` trong `canJoinWithoutReencode` |
| `src/core/film-graph.js` | Ghi `subtitle` vào Voiceover, `subtitles` vào Timeline |
| `src/core/script-check.js` | Ba kiểm tra ở mục 5 |
| `src/app/timeline-export.js` | Thu `en/vi/duration`, ghi font + `.ass`, truyền `subtitlesPath` |
| `src/app/render.js` (node Timeline) | Ô **Phụ đề** |
| `vendor/fonts/`, `licenses/`, `THIRD_PARTY_NOTICES.md` | Font Be Vietnam Pro + giấy phép OFL |
| `series/me-va-be/` | `_series.txt`, `ep01`…`ep05` |
| `series/README.md`, `README.md`, `README-vi.md` | Mục "Phụ đề song ngữ" |

## 8. Kiểm thử

- **Unit:** `parseVoiceLines` (có / không ` | `, `*` lẻ, dòng nối); `parseSubtitleMode`; `buildSubtitleEvents` với cắt cứng, `xfade`, nhiều voice/clip, clip không voice, câu cuối bị cắt ở cuối timeline; `buildAss` (escape, màu tô vàng, PlayRes theo khung); `buildEncodeArgs` có/không `subtitlesPath` (không có → giống hệt cũ); `script-check` ba cảnh báo mới; `film-graph` ghi đúng `subtitle` và TTS nhận text đã bỏ `*`.
- **Thật (một lần):** xuất ep01 với ffmpeg.wasm trong extension, mở MP4 kiểm tra: phụ đề đúng lúc từng câu, dấu tiếng Việt đủ, cụm vàng đúng chỗ, không bị nút TikTok che (xem thử trên điện thoại).
- **Nghiệm thu series:** 5 tập chạy qua Production Queue; chấm mỗi tập theo checklist: nhân vật đúng LUẬT ở mọi cảnh, giọng đúng người, phụ đề khớp, không có chữ do Muse sinh ra, độ dài 45–60 giây.

## Rủi ro

- **Khẩu hình** nhân vật không khớp TTS — chấp nhận với hoạt hình; video prompt chỉ ghi "đang nói vui vẻ" ở cảnh có thoại.
- **Muse trộn phong cách** (ra người thật) khi ảnh tham chiếu yếu — khoá bằng 3 ảnh / nhân vật + `TRÁNH` phong cách người thật.
- **Font trong wasm** — nếu `fontsdir` không được libass nhận, fallback ghi font vào `/usr/share/fonts` hoặc dùng `force_style`/`fontfile`; kế hoạch có bước kiểm chứng trên ffmpeg.wasm thật trước khi viết phần còn lại.
