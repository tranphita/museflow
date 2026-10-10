export const PAUSE_KINDS = new Set(['credits', 'signed-out', 'tts-key']);
export const NO_RETRY_KINDS = new Set(['refused', 'script']);

const SEVERITY = [
  'credits',
  'signed-out',
  'tts-key',
  'script',
  'refused',
  'bridge',
  'timeout',
  'export',
  'unknown',
  'stopped',
];
// Order matters: a refusal quotes arbitrary chat text, so it is matched before words like "log in".
const PATTERNS = [
  ['stopped', /stopped by user|aborterror|đã dừng (?:tạo|lồng tiếng) theo yêu cầu/i],
  ['refused', /(?:^|· )(?:muse could not generate this scene|muse không tạo được cảnh này)/i],
  ['credits', /insufficient (?:image )?credits|out of credits|không đủ credit/i],
  ['signed-out', /sign in|log in|signed out|đăng nhập|đăng xuất/i],
  [
    'tts-key',
    /tvoiceai api key|api key tvoiceai|(?:voiceover service error|lỗi dịch vụ lồng tiếng) \(http 40[13]\)/i,
  ],
  [
    'script',
    /connect a prompt|prompt is empty|end-frame continuity|no scenes found|could not open this episode|nối một node prompt|prompt đang trống|nối tiếp từ khung cuối|không tìm thấy cảnh|không mở được tập này/i,
  ],
  [
    'bridge',
    /message box is (?:not visible|unsupported)|could not attach its page bridge|did not accept the prompt|did not confirm the prompt submission|bridge did not answer|chat is not ready|upload control was not found|did not confirm \d+ reference image|không thấy ô nhập tin nhắn|ô nhập tin nhắn của muse không được hỗ trợ|không gắn được cầu nối trang|muse không nhận prompt|không xác nhận đã gửi prompt|cầu nối trang muse không phản hồi|khung chat muse chưa sẵn sàng|không tìm thấy nút tải ảnh lên|không xác nhận \d+ ảnh tham chiếu/i,
  ],
  ['timeout', /timed out|watchdog|hết thời gian/i],
  ['export', /mp4|ffmpeg|timeline clip|clip timeline/i],
];

export function classifyError(message) {
  const text = String(message || '');
  return PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] || 'unknown';
}

export function worstKind(kinds) {
  return SEVERITY.find(kind => kinds.includes(kind)) || 'unknown';
}
