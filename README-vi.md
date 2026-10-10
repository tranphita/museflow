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
- **Video:** tạo clip, tuỳ chọn dùng frame cuối của clip trước để nối liền cảnh, nút **↻ Again** để tạo lại bám prompt chặt hơn.
- **Phiên bản kết quả:** mỗi node Generate Image/Video giữ 8 kết quả gần nhất. Bấm vào ảnh nhỏ dưới node để quay lại phiên bản cũ.
- **Chạy ổn định hơn:** tuỳ chọn tự thử lại khi tạo lỗi, và tiếp tục chạy phần còn lại của workflow khi một node lỗi (các node phụ thuộc vào node lỗi sẽ bị bỏ qua). Cả hai nằm trong **Settings**.
- **Timeline:** sắp xếp clip, đặt thời lượng, tua và xem trước, thêm **nhạc nền** có chỉnh âm lượng, chọn **hiệu ứng chuyển cảnh**, xuất WebM hoặc MP4 (H.264). MP4 được ghép ngay trên máy bằng FFmpeg đi kèm.
- **Script → Nodes:** biến kịch bản chia cảnh thành các node ảnh/video đã nối sẵn và timeline đúng thứ tự.
- **Tệp workflow:** **Save workflow** tải file JSON có nhúng media khi có thể; **Import workflow** để mở lại. File lưu từ MuseFlow 0.5 vẫn import được.
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
4. Bấm **Run Image** / **Run Video** trên node, hoặc **Run workflow** trên thanh công cụ.
5. Nối kết quả tới node **Preview**. Với video, thêm clip vào **Timeline**, sắp xếp, thêm **♪ Music** nếu muốn, rồi xem trước hoặc xuất.

Với kịch bản, chọn **Script → Nodes**. Tiêu đề cảnh có dạng `CẢNH 1 (0:00–0:07): Tên cảnh`, kèm các trường `Prompt ảnh`, `Prompt video` và `Audio` (tuỳ chọn).

## Làm phim ngắn giữ nguyên nhân vật

Dùng **Script → Nodes** với kịch bản có phần nhân vật (xem [kịch bản mẫu](docs/sample-film-script.txt)):

```
PHONG CÁCH: hoạt hình 3D ấm áp, ánh sáng hoàng hôn

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

Mẹo: chạy riêng các node nhân vật trước, chọn phiên bản ảnh ưng ý (dải **Versions** dưới node), rồi mới **Run workflow** cho cả phim.

## Mở Museta và Muse.ai cạnh nhau

Kéo tab Museta ra thành cửa sổ riêng, nhấn **Windows + mũi tên trái** cho Museta và **Windows + mũi tên phải** cho cửa sổ Muse.ai. Giữ cả hai mở để theo dõi node đang chạy và phản hồi của Muse.

## Khắc phục sự cố

- **Không nhận phiên Muse:** đăng nhập Muse.ai, giữ trang chat mở, tải lại Museta và tab Muse.ai.
- **Thanh trạng thái báo "Muse page changed":** Muse đã đổi giao diện. Vào **Settings → Check Muse session** để xem Museta không còn tìm thấy phần nào của trang. Mọi selector nằm trong [`bridge/muse-ui.js`](bridge/muse-ui.js), thường chỉ cần sửa một dòng ở đó.
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
