# Phim nhiều tập với Museta

Mỗi thư mục con là một bộ phim. Nhân vật được giữ nguyên qua mọi tập.

| Bộ | Thư mục | Nội dung |
| --- | --- | --- |
| Học tiếng Anh cùng Anna & Minh | [hoc-tieng-anh/](hoc-tieng-anh/) | Mỗi tập là một tình huống giao tiếp (chào hỏi, gọi món, hỏi đường), hội thoại tiếng Anh nói chậm, rõ |
| Vy Fit — nhật ký tập gym | [gym-idol/](gym-idol/) | Vlog thể hình hằng ngày của nữ fitness creator Vy: leg day, thân trên, ngày nghỉ và meal prep |

## Cấu trúc một bộ

```
<bo-phim>/
  _series.txt      phong cách + dàn nhân vật, tự ghép vào mọi tập
  ep01-....txt     kịch bản từng tập (chỉ cần các CẢNH)
  characters/      ảnh nhân vật đã chốt: <Tên nhân vật>.png
  workflows/       file .workflow.json để Import workflow (được tạo bằng lệnh bên dưới)
```

## Quy trình

1. **Tạo workflow cho cả bộ**

   ```sh
   npm run series -- series/hoc-tieng-anh series/gym-idol
   ```

2. **Tập 1: chốt gương mặt nhân vật.** Import `workflows/ep01-...workflow.json`, bấm **Run Image** trên từng node "Character: …" cho tới khi ưng, chọn bản đẹp nhất trong dải **Versions** (node tự khoá 🔒). Chuột phải node → **Save character image** và lưu vào `characters/` với đúng tên nhân vật, ví dụ `characters/Anna.png`, `characters/Minh.png`.

3. **Build lại workflow.** Chạy lại lệnh ở bước 1. Từ giờ mọi tập dùng ảnh trong `characters/` (node **Image Input**) thay vì tạo nhân vật mới, nên gương mặt giống nhau ở mọi tập.

4. **Làm từng tập.** Import workflow của tập, bấm **▶ Run workflow**, kiểm tra timeline, thêm **♪ Music** nếu muốn, rồi **⇩ Export** MP4.

## Thêm tập mới

Tạo file `epNN-ten-tap.txt` trong thư mục bộ phim, chỉ viết các cảnh:

```
CẢNH 1 (0:00–0:08): Tên cảnh
Nhân vật: Anna, Minh
Prompt ảnh: ...
Prompt video: ...
Audio: ...
```

Rồi chạy lại `npm run series -- series/<bo-phim>`. Muốn đổi trang phục hay ngoại hình nhân vật cho cả bộ thì sửa `_series.txt` (nếu đã có ảnh trong `characters/`, cần tạo lại ảnh đó).

## Lưu ý

- Mỗi cảnh dài 6–8 giây; Muse tạo video 5, 6, 8 hoặc 10 giây và timeline cắt theo thời lượng trong kịch bản.
- Lời thoại nằm ở dòng `Audio:`. Muse có thể không đọc đúng từng chữ; nếu cần chính xác, hãy lồng tiếng hoặc thêm phụ đề sau khi xuất.
- Bộ gym được viết theo phong cách vlog thể hình lành mạnh. Nội dung quá gợi cảm dễ bị Muse từ chối; khi đó Museta tự thử lại một lần với phương án an toàn.
