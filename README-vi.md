# Museta

**Museta** là extension tạo quy trình trực quan để sinh ảnh và video bằng phiên [Muse.ai](https://muse.ai) bạn đã đăng nhập. Bạn nối các node trên canvas, tạo media rồi sắp xếp clip trên timeline có nhạc nền.

[English](README.md)

**Tải nhanh:** [Tải Museta-extension.zip](https://github.com/tranphita/museflow/raw/refs/heads/main/downloads/Museta-extension.zip) · Không cần cài npm hay build.

Museta phát triển tiếp từ [MuseFlow / 26Flow](https://github.com/bynne2602/museflow) của bynne2602 và giữ giấy phép GPL-2.0-or-later.

## Ảnh giao diện

Ảnh chụp và video demo dưới đây là giao diện MuseFlow gốc; bố cục của Museta không đổi.

[![Video demo MuseFlow](https://img.youtube.com/vi/w7mJwTJyzKw/maxresdefault.jpg)](https://www.youtube.com/watch?v=w7mJwTJyzKw)

![Canvas workflow kết nối với phiên Muse.ai](docs/screenshots/26flow-workflow-canvas.png)

![Timeline với thứ tự clip, ảnh xem trước và thời lượng](docs/screenshots/26flow-timeline-editor.png)

## Tính năng

- **Canvas node:** thêm, kéo, nối, chọn nhiều và tự sắp xếp node. Giữ **Alt** khi kéo để sao chép node kèm kết nối đầu vào; **Ctrl+Z** để hoàn tác. Nhấn **G** rồi kéo để tạo khung nhóm; nhấn **T** để thêm ghi chú. Hỗ trợ phóng to/thu nhỏ, kéo canvas và menu chuột phải.
- **Công cụ prompt:** prompt, negative prompt, Text Append và Text Merge (gộp nhiều nguồn text theo thứ tự nối, dấu phân cách tuỳ chỉnh).
- **Ảnh:** ảnh đầu vào, tối đa 8 ảnh tham chiếu qua node References, tạo ảnh, đổi kích thước, xem trước.
- **Video:** tạo clip, tuỳ chọn dùng frame cuối của clip trước để nối liền cảnh, nút **↻ Làm lại** để tạo lại bám prompt chặt hơn.
- **Phiên bản kết quả:** mỗi node Generate Image/Video giữ 8 kết quả gần nhất. Bấm vào ảnh nhỏ dưới node để quay lại phiên bản cũ.
- **Chạy nhanh hơn:** giọng đọc TTS chạy song song với Muse; **Cài đặt → Số tab Muse dùng cùng lúc** (1–3) chia việc tạo ảnh/video cho nhiều tab chat Muse. Video nối frame (continuity) vẫn chạy lần lượt.
- **Hàng đợi sản xuất:** xếp tập của nhiều bộ phim vào hàng đợi, các tab worker tự sản xuất qua đêm, mỗi worker một cửa sổ Muse riêng. Tập đang dở chạy tiếp từ bước đã xong gần nhất sau khi lỗi hoặc tắt máy.
- **Bảng tiến trình:** liệt kê từng bước, thời gian và lý do lỗi; node đang chạy nhấp nháy và canvas tự theo dõi.
- **Chạy ổn định hơn:** tuỳ chọn tự thử lại khi tạo lỗi, và tiếp tục chạy phần còn lại của workflow khi một node lỗi (các node phụ thuộc vào node lỗi sẽ bị bỏ qua). Cả hai nằm trong **Cài đặt**.
- **Timeline:** sắp xếp clip, đặt thời lượng, tua và xem trước, thêm **nhạc nền** có chỉnh âm lượng, chọn **hiệu ứng chuyển cảnh**, xuất WebM hoặc MP4 (H.264). MP4 được ghép ngay trên máy bằng FFmpeg đi kèm.
- **Lời thoại TTS:** node **Voiceover** đọc văn bản bằng giọng [tvoiceai](https://tvoiceai.com); nối vào cổng **giọng đọc** của Generate Video thì khi xuất MP4, giọng đọc được trộn vào đúng clip đó (âm thanh gốc hạ nhỏ, clip tự kéo dài nếu câu dài hơn). Kịch bản dùng dòng `Lời thoại:` cho từng cảnh và `GIỌNG ĐỌC:` cho cả bộ. Dán API key vào **Cài đặt → Lồng tiếng**; key chỉ lưu trong trình duyệt, không nằm trong workflow.
- **Phụ đề song ngữ:** viết thoại dạng `Tên: English | Tiếng Việt`, bọc mẫu câu cần học trong `*...*`. Bật bằng `PHỤ ĐỀ: song ngữ` trong `_series.txt` (hoặc ô **Phụ đề** trên Timeline): khi xuất MP4, từng câu thoại được gắn lên video đúng lúc đọc — tiếng Anh chữ lớn, tiếng Việt bên dưới, mẫu câu tô vàng. TTS chỉ đọc phần tiếng Anh.
- **Kịch bản → node:** biến kịch bản chia cảnh thành các node ảnh/video đã nối sẵn và timeline đúng thứ tự.
- **Tệp workflow:** **Xuất file** tải file JSON có nhúng media khi có thể; **Mở file** để mở lại. File lưu từ MuseFlow 0.5 vẫn import được.
- **Tự lưu:** workflow và media được lưu trong bộ nhớ extension. Workflow cũ của MuseFlow được chuyển sang tự động ở lần mở đầu tiên.

## Yêu cầu

- Trình duyệt nền Chromium hỗ trợ extension Manifest V3.
- Đã đăng nhập Muse.ai và mở trang chat trong lúc tạo nội dung.
- Tài khoản Muse.ai hỗ trợ chức năng cần dùng. Tỷ lệ khung hình, âm thanh và khả năng tạo video phụ thuộc vào Muse.ai.

Museta kết nối Muse.ai qua page bridge của extension, không dùng backend riêng, API key hay Docker. Khi chạy, prompt và ảnh tham chiếu được gửi tới Muse.ai. Việc xuất timeline chạy hoàn toàn trên máy.

## Cài đặt

1. Tải [Museta-extension.zip](https://github.com/tranphita/museflow/raw/refs/heads/main/downloads/Museta-extension.zip) và giải nén vào một thư mục cố định.
2. Mở `chrome://extensions`.
3. Bật **Developer mode**.
4. Chọn **Load unpacked** và trỏ tới thư mục chứa `manifest.json`.
5. Mở Muse.ai, đăng nhập và vào trang chat.
6. Bấm biểu tượng **Museta** trên thanh công cụ và kiểm tra trạng thái phiên Muse.

### Cập nhật

Thay file bằng phiên bản mới, bấm **Reload** ở trang extension rồi tải lại tab Muse.ai. Nếu nâng cấp từ MuseFlow, hãy gỡ extension MuseFlow cũ sau khi Museta đã mở workflow của bạn một lần.

## Bắt đầu nhanh

1. Thêm node **Prompt** và nhập nội dung.
2. Thêm node **Generate Image** hoặc **Generate Video**.
3. Kéo output của Prompt vào cổng prompt của node tạo. Nối ảnh tham chiếu nếu cần.
4. Bấm **▶ Chạy ảnh** / **▶ Chạy video** trên node, hoặc **Chạy workflow** trên thanh công cụ.
5. Nối kết quả tới node **Xem trước**. Với video, thêm clip vào **Timeline**, sắp xếp, thêm **♪ Nhạc** nếu muốn, rồi xem trước hoặc xuất.

Với kịch bản, chọn **Kịch bản → node**. Tiêu đề cảnh có dạng `CẢNH 1 (0:00–0:07): Tên cảnh`, kèm các trường `Prompt ảnh`, `Prompt video` và `Audio` (tuỳ chọn).

## Studio

Tab **Studio** liệt kê các bộ phim và từng tập. Bấm **Nhập thư mục** và chọn thư mục bộ phim (gồm `_series.txt`, các tập `epXX.txt` và thư mục `characters/`); Museta tự dựng workflow ngay trong trình duyệt. Mỗi tập hiện số cảnh, thời lượng, số câu thoại, trạng thái và lần chạy gần nhất, kèm nút **Xếp hàng**, **Mở trong Canvas**, và khi đã có MP4 là **Phát**, **Tải MP4**. **Xếp hàng cả bộ** xếp các tập chưa xong của bộ phim vào hàng đợi; **Xếp hàng mọi bộ** ở cột trái xếp tập của mọi bộ, xen kẽ giữa các bộ. Sửa kịch bản xong thì bấm **Cập nhật từ thư mục**.

## Hàng đợi sản xuất (Production)

1. Xếp tập vào hàng đợi trong Studio.
2. Mở tab **Sản xuất**, xem **Cài đặt hàng đợi** (số worker, số lần thử mỗi tập, thời gian nghỉ giữa các lượt gửi Muse, URL chat mới) rồi bấm **Bắt đầu**. Mỗi worker mở một cửa sổ Muse và một tab worker. Lần đầu hãy đăng nhập Muse trong từng cửa sổ và giữ chúng mở. Để các cửa sổ Muse hiện trên màn hình, không thu nhỏ và không bị cửa sổ khác che kín, vì Chrome làm chậm trang trong cửa sổ bị ẩn.
3. Để Chrome chạy qua đêm. Máy không ngủ khi hàng đợi còn việc; mỗi tập bắt đầu bằng một cuộc chat Muse mới; MP4 được xuất lần lượt từng tập.
4. Sáng ra duyệt: **Phát**, rồi **Duyệt** (tập chuyển sang Done trong Studio), **Làm lại** (làm lại từ đầu) hoặc **Mở trong Canvas** để sửa tay từng cảnh. **Tải tất cả** tải các MP4 đã duyệt.
5. Hàng đợi tự tạm dừng khi Muse hết credit, một cửa sổ worker bị đăng xuất hoặc bị đóng, API key tvoiceai thiếu hoặc sai, hoặc ba tập liên tiếp không gửi được tới Muse. Xử lý xong bấm **Tiếp tục**: các tập dở chạy tiếp từ bước đã xong. Lỗi khác tự thử lại sau 1, 5 và 15 phút; tập lỗi mãi hoặc bị Muse từ chối sẽ nằm ở **Cần xử lý** kèm lý do.

## Làm phim ngắn giữ nguyên nhân vật

Dùng **Kịch bản → node** với kịch bản có phần nhân vật (xem [kịch bản mẫu](docs/sample-film-script.txt)):

```
PHONG CÁCH: phim người thật, photorealistic, ánh sáng tự nhiên, không hoạt hình, không 3D

NHÂN VẬT:
- Linh: cô gái 20 tuổi, tóc bob đen, áo khoác vàng
- Mun: mèo đen mắt xanh, vòng cổ đỏ

CẢNH 1 (0:00–0:06): Gặp gỡ
Nhân vật: Linh, Mun
Prompt ảnh: ...
Prompt video: ...
Audio: ...
```

Museta sẽ:

- tạo một ảnh tham chiếu (character sheet) cho mỗi nhân vật và nối ảnh đó vào mọi cảnh có nhân vật — theo dòng `Nhân vật:` của cảnh, hoặc theo tên được nhắc trong prompt;
- thêm mô tả nhân vật và dòng `PHONG CÁCH` vào prompt từng cảnh, kèm lệnh **CHARACTER LOCK** yêu cầu Muse giữ nguyên gương mặt, tóc, trang phục;
- bật continuity cho các clip sau (clip mới bắt đầu từ frame cuối của clip trước) và yêu cầu mỗi clip kết thúc bằng khung hình ổn định dẫn sang cảnh kế tiếp;
- đặt chuyển cảnh **Crossfade 0.5s** cho timeline. Đổi kiểu (Cut, Crossfade, Fade through black, Dissolve, Slide left) và độ dài ở ô **⇄** trên dock timeline; hiệu ứng được áp dụng khi xuất MP4.

Muốn có sẵn file để **Mở file** thay vì dán kịch bản: chạy `npm run script-to-workflow -- kich-ban.txt` để tạo `kich-ban.workflow.json` (ví dụ: [docs/sample-film.workflow.json](docs/sample-film.workflow.json)).

Mẹo: chạy riêng các node nhân vật trước, chọn phiên bản ảnh ưng ý (dải **Phiên bản** dưới node) hoặc tick **🔒 Giữ kết quả này**, rồi mới **Chạy workflow** cho cả phim. Node đã khoá sẽ được giữ nguyên khi chạy cả workflow; bấm **▶ Chạy ảnh** trên chính node đó vẫn tạo lại được.

## Phim nhiều tập

Thư mục [series/](series/README.md) chứa sẵn hai bộ: **học tiếng Anh cùng Anna & Minh** và **Vy Fit — nhật ký tập gym**. Mỗi bộ có `_series.txt` (phong cách + nhân vật dùng chung), các tập `epXX.txt` và thư mục `characters/` để lưu ảnh nhân vật đã chốt, giúp mọi tập dùng cùng một gương mặt. Tạo workflow cho cả bộ bằng `npm run series -- series/hoc-tieng-anh`.

## Mở Museta và Muse.ai cạnh nhau

Kéo tab Museta ra thành cửa sổ riêng, nhấn **Windows + mũi tên trái** cho Museta và **Windows + mũi tên phải** cho cửa sổ Muse.ai. Giữ cả hai mở để theo dõi node đang chạy và phản hồi của Muse.

## Khắc phục sự cố

- **Không nhận phiên Muse:** đăng nhập Muse.ai, giữ trang chat mở, tải lại Museta và tab Muse.ai.
- **Thanh trạng thái báo "Muse page changed":** Muse đã đổi giao diện. Vào **Cài đặt → Kiểm tra phiên Muse** để xem Museta không còn tìm thấy phần nào của trang. Mọi selector nằm trong [`bridge/muse-ui.js`](bridge/muse-ui.js), thường chỉ cần sửa một dòng ở đó.
- **Muse từ chối tạo cảnh:** Museta nhận diện lời từ chối (kể cả tiếng Việt) và tự thử lại cảnh đó một lần với prompt thay thế an toàn gần nhất. Muse.ai vẫn quyết định có tạo được hay không.
- **Xuất timeline lỗi:** tải lại extension rồi thử lại. MP4 dùng FFmpeg đi kèm; WebM dùng `MediaRecorder` của trình duyệt.
- **Kết quả không đúng thông số:** Muse.ai quyết định media đầu ra và có thể không luôn theo tỷ lệ, âm thanh hay tuỳ chọn video được yêu cầu.

## Dữ liệu và quyền truy cập

Workflow và media lưu cục bộ trong bộ nhớ extension; media không còn dùng tới được tự dọn. Extension cần quyền lưu trữ, truy cập tab và chèn script để lưu workflow và làm việc với tab Muse.ai. Không có tài khoản hay máy chủ Museta.

## Phát triển

Không có bước build: extension nạp `src/main.js` dạng ES module. Chỉ cần Node.js 22+ để chạy kiểm thử.

```sh
npm test          # unit test (node:test, không dependency)
npm run lint      # eslint qua npx
npm run format    # prettier qua npx
npm run package   # tạo downloads/Museta-extension.zip từ HEAD đã commit
```

Xem bảng cấu trúc thư mục trong [README.md](README.md#development).

## Giấy phép

Museta dùng [GNU General Public License v2.0 trở lên](LICENSE), cùng loại với FFmpeg core đi kèm. JavaScript wrapper của FFmpeg dùng MIT. Xem [thông báo bên thứ ba](THIRD_PARTY_NOTICES.md).
