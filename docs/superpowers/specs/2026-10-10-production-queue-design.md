# Production Queue — thiết kế

Phần 1/4 của lộ trình "sản xuất hàng loạt series short video". Các phần sau (Script Factory, Auto-QC, Hậu kỳ) có spec riêng và xây trên hàng đợi này.

## Mục tiêu

- Kênh của chính chủ, mục tiêu **trên 20 tập/ngày**, chạy qua đêm không cần trông.
- Chỉ dùng Muse (token dồi dào); tối ưu là **độ bền** và **thông lượng**, không phải chi phí.
- Chốt duyệt của người dùng: kịch bản (phần 2) và video cuối (phần này: trạng thái `review`).
- Xong khi: xếp 20 tập từ nhiều series vào hàng đợi buổi tối, sáng mở ra thấy các tập ở `review` kèm MP4, tập lỗi có lý do rõ ràng; tắt Chrome giữa chừng rồi mở lại thì chạy tiếp từ cảnh đang dở.

Ngoài phạm vi: viết kịch bản tự động, chấm ảnh tự động, phụ đề/caption, đăng bài.

## Ràng buộc từ code hiện tại

- Video trong một tập chạy **tuần tự** (cảnh N cần khung cuối cảnh N−1), nên một tập mất khoảng 20 phút bất kể số tab. Chạy tuần tự 20 tập ≈ 7 giờ.
- Runner gắn với canvas toàn cục (`state`), không chạy được hai tập song song trong cùng một trang.
- `saveWorkflowSnapshot` gọi `pruneMedia` xoá mọi media không thuộc workflow đang mở — sẽ xoá media của tab khác.
- Media key là `${field}:${nodeId}`, node id là UUID nên không đụng nhau giữa các tab.
- Chrome bóp timer của tab nền (tối thiểu ~1 lần/phút sau 5 phút ẩn); tab không active có thể bị discard.

## 1. Mô hình thực thi: worker tab

- **Worker** = một tab `app.html?worker=<n>` + một cửa sổ Muse riêng của nó. Mỗi tab trang có `state` riêng trong bộ nhớ, nên runner hiện tại chạy nguyên trong worker.
- Worker tự nhận job từ hàng đợi chung trong IndexedDB, chạy, xuất MP4, rồi nhận job kế tiếp. Không cần tab điều phối sống thì worker mới chạy.
- **Tab điều phối** = view **Production** trong tab Museta chính: mở/đóng worker, hiển thị bảng, giữ máy thức. Không tự sinh hình.
- Worker ghim vào đúng tab Muse của nó: `settings.museTabs` bị ép về 1 và mọi lệnh gửi Muse dùng `museTabMessage(..., tabId, signal, { onlyThisTab: true })`.
- Mỗi cửa sổ Muse là một cửa sổ thường (không minimize) chứa đúng một tab Muse, nên tab đó luôn "visible" và content script không bị bóp timer. Tab worker và tab Muse được đặt `autoDiscardable: false`.
- Đầu mỗi job, worker đưa tab Muse về trang chủ `https://muse.ai/` để mở cuộc chat mới (tránh lẫn ngữ cảnh giữa các tập và DOM phình to), đợi `MUSETA_CHECK_SESSION` báo sẵn sàng. Kế hoạch có bước xác nhận URL "chat mới" này trên Muse thật trước khi dựa vào.
- Xuất MP4 (FFmpeg WASM, tốn RAM) chạy qua `navigator.locks.request('museta-ffmpeg', …)` để mỗi lúc chỉ một worker encode.
- Số worker mặc định 3, chỉnh 1–4 trong Production. Ước tính 3 worker: 20 tập ≈ 2,5 giờ.

## 2. Job và lưu trữ

Object store mới `jobs` (keyPath `id`) trong DB `museta-library`, nâng lên version 2; store `series`, `outputs` giữ nguyên. Mở DB dùng chung một helper cho cả series/outputs/jobs.

```
queued ──claim──▶ running ──clips xong──▶ exporting ──MP4 xong──▶ review ──Duyệt──▶ done
   ▲                 │                         │                    │
   │                 ├─ lỗi retry được ────────┤                    └─ Làm lại ─▶ queued (bỏ checkpoint)
   ├─ lease hết hạn ─┘                         │
   ├─ Retry (tay) ◀── failed ◀─ hết lượt / lỗi không retry được
   └─ Stop now (giữ checkpoint, hàng đợi chuyển sang tạm dừng)
```

Trường của job:

| Trường | Ý nghĩa |
|---|---|
| `id` | `job-<uuid>` |
| `seriesId`, `episodeId`, `title` | Tham chiếu tới series/tập trong Studio; `title` để hiển thị |
| `script` | Bible + kịch bản tại lúc xếp hàng (sửa file sau đó không ảnh hưởng) |
| `order` | Số thứ tự nhận việc, nhỏ trước |
| `status` | Một trong các trạng thái ở sơ đồ |
| `attempts` | Số lần đã chạy (tính cả lần lease hết hạn) |
| `notBefore` | Thời điểm sớm nhất được nhận lại (backoff) |
| `workerId`, `heartbeatAt` | Lease |
| `startedAt`, `endedAt`, `runMs` | Thời gian |
| `progress` | `{ done, total, current }` từ run panel |
| `error`, `errorKind` | Lỗi gần nhất và phân loại (mục 3) |
| `checkpoint` | Workflow đã dehydrate sau bước thành công gần nhất |
| `outputKey` | Key MP4 trong store `outputs` |

Quy tắc:

- **Claim** trong một readwrite transaction trên `jobs` (IndexedDB tuần tự hoá transaction giữa các tab): chọn job có `order` nhỏ nhất mà `status === 'queued' && notBefore <= now`, **hoặc** `status ∈ {running, exporting}` và lease hết hạn (`now - heartbeatAt > 5 phút`). Ghi `status: running`, `workerId`, `heartbeatAt`, tăng `attempts` nếu nhận lại từ lease hết hạn.
- **Heartbeat** mỗi 30 giây (chịu được bóp timer); lease 5 phút.
- **Checkpoint**: mỗi khi run panel đánh dấu một bước `done`, worker dehydrate workflow hiện tại và ghi vào `job.checkpoint` (gộp ghi, tối đa 1 lần/5 giây).
- **Chạy tiếp**: nếu job có `checkpoint`, worker nạp nó thay vì dựng lại từ `script`, khoá mọi node generator `status === 'success'` và voiceover đã có audio (runner đã bỏ qua node khoá và vẫn dùng output của chúng cho continuity), rồi chạy phần còn lại.
- **Media của worker** dùng key có tiền tố `job:<jobId>:`. `pruneMedia` ở tab canvas bỏ qua mọi key có tiền tố `job:`. Media của job bị xoá khi job được Duyệt, Làm lại, hoặc bị xoá khỏi bảng (MP4 trong `outputs` giữ lại).
- **Thứ tự xen kẽ**: khi xếp nhiều tập từ nhiều series cùng lúc, `order` được gán xen kẽ theo series (A1, B1, A2, B2, …) để series nào cũng có tập mới.
- Worker **không** đọc/ghi key `museta` trong `chrome.storage.local`; settings chung (autoRetry, continueOnError, tts key) vẫn đọc từ đó, chỉ ép `museTabs = 1`.
- Studio đọc trạng thái mỗi tập từ job mới nhất của tập đó. `studio.queue`, `runEpisode/runEpisodes` trong Studio và modal **Batch** bị thay bằng hàng đợi này.

## 3. Độ bền khi chạy qua đêm

### Phân loại lỗi (`classifyError(message) → kind`)

| kind | Nhận diện (từ thông điệp hiện có) | Xử lý |
|---|---|---|
| `stopped` | AbortError do Stop now (abort của watchdog được tính là `timeout`) | Job → `queued`, giữ checkpoint |
| `credits` | "insufficient … credits" | **Tạm dừng cả hàng đợi**, job → `queued` |
| `signed-out` | "Open Muse.ai and sign in", màn hình đăng nhập | Tạm dừng cả hàng đợi, job → `queued` |
| `tts-key` | lỗi thiếu/sai API key tvoiceai | Tạm dừng cả hàng đợi, job → `queued` |
| `bridge` | "message box is not visible", "could not attach its page bridge", "did not accept the prompt", "bridge did not answer" | Reload tab Muse, job retry |
| `timeout` | Muse không trả attachment trước hạn | Job retry |
| `refused` | Vẫn bị từ chối sau lần thử "safe equivalent" | Job → `failed` (cần sửa kịch bản) |
| `script` | Prompt rỗng, thiếu continuity, kịch bản không có cảnh | Job → `failed` |
| `export` | MP4 không xuất được | Job retry (chỉ bước export) |
| `unknown` | Còn lại | Job retry |

- **Retry**: tối đa 3 lượt (chỉnh trong Production). Backoff qua `notBefore`: 1, 5, 15 phút. Nhờ checkpoint, retry chỉ chạy lại các bước chưa xong. Retry bên trong một bước (`settings.autoRetry`) vẫn giữ như cũ.
- **Watchdog**: worker theo dõi tiến độ của chính nó; nếu 15 phút không có bước nào đổi trạng thái (bridge tự timeout sau tối đa 10 phút), worker abort run hiện tại, reload tab Muse và coi là lỗi `timeout`.
- **Cầu dao**: nếu **3 job liên tiếp** (tính chung mọi worker) lỗi `bridge` hoặc `timeout`, cả hàng đợi tạm dừng với lý do "Muse không phản hồi như mong đợi — có thể giao diện đã đổi". Trạng thái tạm dừng lưu trong store `jobs` dưới bản ghi `id: 'queue-control'` để mọi worker cùng thấy.
- **Tạm dừng**: worker không nhận job mới; job đang chạy chạy nốt (Pause) hoặc bị abort và trả về `queued` giữ checkpoint (Stop ngay).
- **Giữ máy thức**: khi hàng đợi chạy, tab điều phối gọi `chrome.power.requestKeepAwake('system')` (thêm quyền `power`), nhả khi hàng đợi rỗng hoặc tạm dừng.
- **Giãn nhịp**: setting `cooldownSec` (mặc định 0) — mỗi worker nghỉ chừng đó giây giữa hai lượt gửi Muse, phòng khi Muse rate-limit.

## 4. Giao diện

### Studio

- Nút **Run** mỗi tập đổi thành **Queue**; thêm **Queue all** (mọi tập chưa `done`/`review` của series) và nút **Queue every series** ở sidebar (xếp xen kẽ).
- Chip trạng thái tập đọc từ job: Queued / Running · cảnh 3/6 · Worker 2 / Review / Done / Failed: lý do.
- Kiểm tra kịch bản (`checkEpisode`) vẫn chạy trước khi xếp; tập có lỗi `error` hỏi xác nhận như hiện nay.

### View Production (tab thứ ba của `.view-switch`: Studio · Production · Canvas)

- **Thanh điều khiển**: Start / Pause / Stop now; số worker; trạng thái từng worker (đang chạy job nào, chấm xanh/đỏ theo heartbeat); dòng tóm tắt "12 xong · 3 chờ xem · 1 lỗi · ~40 phút còn lại" (ETA = số job còn lại × thời gian trung bình / số worker đang chạy). Khi hàng đợi tạm dừng tự động, banner nêu lý do và nút Resume.
- **Danh sách theo nhóm** (không phải kanban): Đang chạy (thanh tiến độ cảnh, worker, thời gian) → Chờ xem (play, **Duyệt**, **Làm lại**, **Mở trong canvas**, tải MP4) → Đang chờ (nút ↑/↓ đổi thứ tự, xoá) → Lỗi (loại lỗi, thông điệp, **Retry**, **Mở trong canvas**) → Xong (gần nhất trước, **Tải các tập đã duyệt**, **Dọn danh sách**).
- **Mở trong canvas** nạp checkpoint vào canvas chính để sửa tay (media được copy sang key thường khi canvas lưu).

### Tab worker

- Mở `app.html?worker=<n>`: `body[data-mode="worker"]`, hiện canvas của job đang chạy ở chế độ chỉ xem cùng run panel và banner "Worker n — đang chạy <tập>. Đừng sửa hoặc đóng tab này." Phím tắt chỉnh sửa và autosave tắt.

## 5. Cấu trúc code

| File | Vai trò |
|---|---|
| `src/core/jobs.js` (mới, thuần) | `createJob`, `pickNextJob(jobs, now)`, `isLeaseExpired`, `nextAttempt(job, kind, now)` (backoff + quyết định trạng thái), `interleave(episodesBySeries)`, `queueSummary(jobs, now)` (đếm + ETA), `shouldTripBreaker(recentKinds)` |
| `src/core/job-errors.js` (mới, thuần) | `classifyError`, `PAUSE_KINDS`, `RETRY_KINDS` |
| `src/core/checkpoint.js` (mới, thuần) | `lockFinishedSteps(workflow)` |
| `src/app/library-store.js` | DB v2 + store `jobs`; `putJob`, `listJobs`, `claimJob(workerId, now)`, `updateJob(id, patch)`, `deleteJob`, `getQueueControl`, `setQueueControl` |
| `src/app/worker.js` (mới) | Vòng lặp worker: claim → chuẩn bị tab Muse → nạp script/checkpoint → `executeWorkflow` → export → `review`; heartbeat, checkpoint, watchdog, phân loại lỗi |
| `src/app/production.js` (mới) | View Production, mở/đóng worker và cửa sổ Muse, keep-awake, hiển thị bảng (đọc lại mỗi 2 giây) |
| `src/app/studio.js` | Bỏ chạy trực tiếp; thêm xếp hàng và đọc trạng thái từ job |
| `src/app/batch.js` + modal Batch | Xoá |
| `src/app/persistence.js` | `loadWorkflowObject(workflow, { persist })`; chế độ worker không lưu key `museta`; prune bỏ qua key `job:` |
| `src/app/media-store.js` | `dehydrateNodeMedia(nodes, { keyPrefix })` |
| `src/app/run-panel.js` | `onRunStep(listener)` để worker bắt sự kiện bước xong |
| `manifest.json` | Thêm quyền `power` |

## 6. Kiểm thử

- **Unit** (`node:test`): chọn job (thứ tự, `notBefore`, lease hết hạn), chuyển trạng thái theo từng `errorKind`, backoff, xếp xen kẽ, ETA, cầu dao, `classifyError` trên các thông điệp lỗi thật của bridge/runner, `lockFinishedSteps`.
- **Smoke Playwright** với `fake-muse.html`: 2 worker, 3 job từ 2 series → cả 3 tới `review` kèm MP4; đóng một tab worker giữa chừng → job được worker kia nhận lại sau khi lease hết hạn và chạy tiếp từ checkpoint (số lượt sinh không tăng cho các cảnh đã xong); fake Muse trả lỗi hết credit → hàng đợi tạm dừng với banner đúng lý do.
- **Thật**: một lượt 3 tập × 2 worker trên tài khoản Muse của chủ kênh, xác nhận URL chat mới, cửa sổ Muse không bị bóp timer, MP4 đúng.
