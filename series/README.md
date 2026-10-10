# Phim nhiều tập với Museta

Mỗi thư mục con là một bộ phim. Nhân vật được giữ nguyên qua mọi tập.

| Bộ | Thư mục | Nội dung |
| --- | --- | --- |
| Vợ dạy chồng tiếng Anh (Hảo & Phi Ta) | [hoc-tieng-anh/](hoc-tieng-anh/) | Hảo giỏi tiếng Anh, Phi Ta giao tiếp cơ bản. Mỗi tập theo format "chồng nói sai → vợ sửa → luyện → twist hài → nhắc lại": lỗi sai ở nhà, gọi đồ uống, đi siêu thị, check-in khách sạn, ngày kỷ niệm |
| Hảo Fit — nhật ký tập gym | [gym-idol/](gym-idol/) | Vlog thể hình hằng ngày của nữ fitness creator Hảo: leg day, thân trên, ngày nghỉ và meal prep |

## Cấu trúc một bộ

```
<bo-phim>/
  _series.txt      phong cách + dàn nhân vật, tự ghép vào mọi tập
  ep01-....txt     kịch bản từng tập (chỉ cần các CẢNH)
  characters/      ảnh nhân vật: <Tên>.png, <Tên>-2.png… (không commit)
  workflows/       file .workflow.json để Import workflow, tạo bằng lệnh bên dưới (không commit)
```

## Dùng trong Studio (không cần lệnh npm)

Mở Museta → tab **Studio** → **Import folder** → chọn thư mục bộ phim (ví dụ `series\hoc-tieng-anh`). Museta đọc `_series.txt`, các tập `epXX.txt` và ảnh trong `characters/`, rồi hiện danh sách tập. Mỗi tập có nút **Run**; **Run all episodes** chạy cả bộ. MP4 được lưu trong Studio — bấm **Play** để xem, **Download MP4** để tải. Sửa kịch bản xong thì bấm **Update from folder** và chọn lại thư mục; tập nào đổi nội dung sẽ hiện "Script changed".

Thêm dòng `TÊN BỘ:` vào `_series.txt` và `TIÊU ĐỀ:` ở đầu mỗi tập để Studio hiển thị tên có dấu.

## Quy trình bằng dòng lệnh

1. **Tạo workflow cho cả bộ**

   ```sh
   npm run series -- series/hoc-tieng-anh series/gym-idol
   ```

2. **Tập 1: chốt gương mặt nhân vật.** Import `workflows/ep01-...workflow.json`, bấm **Run Image** trên từng node "Character: …" cho tới khi ưng, chọn bản đẹp nhất trong dải **Versions** (node tự khoá 🔒). Chuột phải node → **Save character image** và lưu vào `characters/` với đúng tên nhân vật, ví dụ `characters/Hảo.png`, `characters/Phi Ta.png`.

3. **Build lại workflow.** Chạy lại lệnh ở bước 1. Từ giờ mọi tập dùng ảnh trong `characters/` (node **Image Input**) thay vì tạo nhân vật mới, nên gương mặt giống nhau ở mọi tập.

4. **Chạy cả bộ một lần:** bấm **Batch** → **Add workflow files** → chọn tất cả file trong `workflows/` → **Start queue**. Museta chạy từng tập và lưu `epXX-....mp4` vào thư mục Downloads. Muốn nhanh hơn: mở 2–3 tab chat Muse mới và chọn số tab tương ứng trong **Settings**.
5. **Làm từng tập.** Import workflow của tập, bấm **▶ Run workflow**, kiểm tra timeline, thêm **♪ Music** nếu muốn, rồi **⇩ Export** MP4.

## Luật giữ nhất quán (LUẬT)

Viết những chi tiết **không bao giờ được đổi** vào `_series.txt`, mỗi nhân vật một dòng, các luật cách nhau bằng dấu `;`:

```
LUẬT:
- Phi Ta: luôn đeo kính gọng vuông màu đen trong mọi cảnh; không để râu
- Hảo: không đeo kính, kể cả kính râm; luôn đeo bông tai ngọc trai nhỏ
- Chung: không chữ, logo, phụ đề hay watermark trên hình
```

Luật của nhân vật được gửi kèm mọi cảnh có người đó (mục **CONTINUITY RULES** ngay sau khoá nhận diện); dòng `Chung` áp dụng cho mọi cảnh. Studio tự kiểm tra từng tập trước khi chạy và báo:

- cảnh viết ngược luật (ví dụ "tháo kính" khi luật là "luôn đeo kính", hoặc "Hảo đeo kính râm" khi luật là "không đeo kính");
- người có thoại hoặc được nhắc trong prompt nhưng thiếu ở dòng `Nhân vật` (Muse sẽ không có ảnh của người đó);
- lời thoại dài hơn thời lượng cảnh, cảnh dài quá 10 giây.

Tập có lỗi hiện nhãn đỏ; bấm vào để xem từng lỗi theo cảnh. `npm run series` cũng in các lỗi này.

## Dùng chính bạn (và người thân) làm nhân vật

1. Trong `_series.txt`, đặt tên nhân vật theo tên thật và mô tả ngoại hình, trang phục muốn giữ cố định, ví dụ:

   ```
   NHÂN VẬT:
   - Tuấn: người đàn ông Việt Nam 32 tuổi, người thật, tóc ngắn, áo thun trắng, quần jean
   - Lan: người phụ nữ Việt Nam 30 tuổi, người thật, tóc dài ngang vai, váy hoa xanh
   ```

2. Chép ảnh vào `characters/`, tên file trùng tên nhân vật. Có thể dùng tối đa 3 ảnh mỗi người: `Tuấn.jpg`, `Tuấn-2.jpg`, `Tuấn-3.jpg`.
   - Ảnh 1: chính diện, rõ mặt, đủ sáng, không đeo kính râm, không filter.
   - Ảnh 2: nửa người hoặc toàn thân, mặc đúng trang phục ghi trong `_series.txt`.
   - Ảnh 3 (tuỳ chọn): góc nghiêng 3/4.
3. Chạy `npm run series -- series/<bo-phim>` rồi import workflow như bình thường. Các cảnh sẽ nhận ảnh thật làm tham chiếu thay vì tạo nhân vật bằng AI.

Ảnh trong `characters/` và các file trong `workflows/` (vốn nhúng ảnh bên trong) **không được commit** — `.gitignore` đã chặn để ảnh cá nhân không bị đẩy lên GitHub. Chỉ dùng ảnh của người đã đồng ý. Muse quyết định mức độ giống; nếu Muse từ chối tạo theo ảnh người thật, hãy thử ảnh khác hoặc giảm số ảnh.

## Lời thoại bằng giọng TTS (tvoiceai)

Thêm dòng `Lời thoại:` vào cảnh để Museta đọc bằng giọng TTS và trộn vào đúng clip khi xuất MP4 (âm thanh gốc của clip được hạ nhỏ bên dưới, clip tự kéo dài nếu câu đọc dài hơn). Đặt giọng mặc định bằng `GIỌNG ĐỌC: <voice id>` và giọng riêng cho từng nhân vật bằng `GIỌNG ĐỌC <Tên>: <voice id>` trong `_series.txt`. Hội thoại nhiều người viết theo từng dòng:

```
Lời thoại:
- Hảo: Good morning, honey!
- Phi Ta: Good morning! I'm fine, thank you.
```

Mỗi dòng thành một node Voiceover với giọng của người nói; khi xuất MP4 các câu được xếp nối tiếp trong clip (cách nhau 0,35 giây) và clip tự kéo dài cho đủ thoại. Dán API key tvoiceai vào **Settings → Voiceover** một lần; key chỉ lưu trong trình duyệt, không nằm trong workflow. Cả hai bộ đã dùng sẵn cách này; bộ học tiếng Anh dùng giọng riêng cho Hảo và Phi Ta.

## Thêm tập mới

Tạo file `epNN-ten-tap.txt` trong thư mục bộ phim, chỉ viết các cảnh:

```
CẢNH 1 (0:00–0:08): Tên cảnh
Nhân vật: Hảo, Phi Ta
Prompt ảnh: ...
Prompt video: ...
Audio: ...
```

Rồi chạy lại `npm run series -- series/<bo-phim>`. Muốn đổi trang phục hay ngoại hình nhân vật cho cả bộ thì sửa `_series.txt` (nếu đã có ảnh trong `characters/`, cần tạo lại ảnh đó).

## Lưu ý

- Mỗi cảnh dài 6–8 giây; Muse tạo video 5, 6, 8 hoặc 10 giây và timeline cắt theo thời lượng trong kịch bản.
- Lời thoại nằm ở dòng `Audio:`. Muse có thể không đọc đúng từng chữ; nếu cần chính xác, hãy lồng tiếng hoặc thêm phụ đề sau khi xuất.
- Bộ gym được viết theo phong cách vlog thể hình lành mạnh. Nội dung quá gợi cảm dễ bị Muse từ chối; khi đó Museta tự thử lại một lần với phương án an toàn.
