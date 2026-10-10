import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, worstKind, PAUSE_KINDS, NO_RETRY_KINDS } from '../../src/core/job-errors.js';

const cases = [
  ['Đã dừng tạo theo yêu cầu của bạn.', 'stopped'],
  ['Đã dừng lồng tiếng theo yêu cầu của bạn.', 'stopped'],
  ['Muse không tạo được cảnh này: Mình không thể tạo cảnh này, vui lòng đăng nhập lại', 'refused'],
  ['Museta 0.10.0 · Muse không tạo được cảnh này: please log in again', 'refused'],
  ['Tài khoản Muse không đủ credit tạo ảnh. Hãy nạp thêm credit rồi thử lại.', 'credits'],
  ['Mở Muse.ai và đăng nhập rồi thử lại.', 'signed-out'],
  ['Tab Muse của worker này đã bị đóng. Mở Muse.ai và đăng nhập rồi thử lại.', 'signed-out'],
  ['Muse đã đăng xuất. Mở Muse.ai và đăng nhập rồi thử lại.', 'signed-out'],
  ['Dán API key tvoiceai vào Cài đặt → Lồng tiếng, bấm Lưu rồi chạy lại.', 'tts-key'],
  ['Hãy thêm API key tvoiceai trong Cài đặt → Lồng tiếng trước.', 'tts-key'],
  ['Lỗi dịch vụ lồng tiếng (HTTP 401): invalid key', 'tts-key'],
  ['Generate Video n1: hãy nối một node Prompt, Text Append hoặc Text Merge trước.', 'script'],
  ['Prompt đang trống.', 'script'],
  ['Nối tiếp từ khung cuối cho n2 cần clip trước đó trên Timeline đã tạo thành công', 'script'],
  ['Không tìm thấy cảnh nào. Dùng tiêu đề dạng “CẢNH 1 (0:00–0:07): Tên cảnh”.', 'script'],
  ['Không mở được tập này.', 'script'],
  ['Không thấy ô nhập tin nhắn của Muse. Mở khung chat rồi thử lại.', 'bridge'],
  ['Ô nhập tin nhắn của Muse không được hỗ trợ.', 'bridge'],
  ['Đã thấy tab Muse nhưng Museta không gắn được cầu nối trang: x', 'bridge'],
  ['Muse không nhận prompt vào ô nhập tin nhắn. Chưa có gì được gửi.', 'bridge'],
  ['Muse không xác nhận đã gửi prompt. Kiểm tra khung chat rồi thử lại', 'bridge'],
  ['Cầu nối trang Muse không phản hồi.', 'bridge'],
  ['Khung chat Muse chưa sẵn sàng sau 90 giây.', 'bridge'],
  ['Không tìm thấy nút tải ảnh lên của Muse gần khung chat; prompt chưa được gửi.', 'bridge'],
  ['Muse không xác nhận 2 ảnh tham chiếu trong khung chat (ô tải lên nhận: image/*)', 'bridge'],
  ['Hết thời gian chờ video mới từ Muse. Prompt đã được gửi một lần và không gửi lại.', 'timeout'],
  ['Hết thời gian chờ lồng tiếng.', 'timeout'],
  ['Không có tiến triển trong 15 phút nên watchdog đã dừng lượt chạy.', 'timeout'],
  ['FFmpeg tạo ra file MP4 rỗng.', 'export'],
  ['Xuất timeline thất bại: Không tải được clip timeline 2 (HTTP 404).', 'export'],
  ['Museta 0.10.0 · Tài khoản Muse không đủ credit tạo ảnh.', 'credits'],
  ['Something odd happened', 'unknown'],
  ['', 'unknown'],
];

const legacyEnglishCases = [
  ['Generation stopped by user.', 'stopped'],
  ['Muse could not generate this scene: Mình không thể tạo cảnh này, please log in again', 'refused'],
  ['Muse account has insufficient image credits.', 'credits'],
  ['Open Muse.ai and sign in, then retry.', 'signed-out'],
  ['Paste your tvoiceai API key in Settings → Voiceover, press Save, then run again.', 'tts-key'],
  ['Voiceover service error (HTTP 401): invalid key', 'tts-key'],
  ['End-frame continuity for n2 needs the previous Timeline clip to be generated successfully', 'script'],
  ['Muse did not confirm 2 reference images in the chat composer (upload input accepts: image/*)', 'bridge'],
  ['Timed out waiting for a new Muse video attachment. Prompt was submitted once', 'timeout'],
  ['FFmpeg produced an empty MP4 file.', 'export'],
];

test('error messages from the bridge, runner and services are classified', () => {
  for (const [message, kind] of cases) assert.equal(classifyError(message), kind, message);
});

test('older English error messages saved before the translation are still classified', () => {
  for (const [message, kind] of legacyEnglishCases) assert.equal(classifyError(message), kind, message);
});

test('the most serious kind wins and kinds are grouped by how the queue reacts', () => {
  assert.equal(worstKind(['timeout', 'credits', 'bridge']), 'credits');
  assert.equal(worstKind(['timeout', 'refused']), 'refused');
  assert.equal(worstKind([]), 'unknown');
  assert.deepEqual([...PAUSE_KINDS], ['credits', 'signed-out', 'tts-key']);
  assert.deepEqual([...NO_RETRY_KINDS], ['refused', 'script']);
});
