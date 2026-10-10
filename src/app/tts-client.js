import { isRateLimited, retryDelayMs } from '../core/rate-limit.js';

const TTS_BASE = 'https://tvoiceai.com';
const SECRETS_KEY = 'museta-secrets';
const POLL_MS = 3000;
const TIMEOUT_MS = 5 * 60 * 1000;
const RATE_LIMIT_RETRIES = 6;
// Shared by every Museta tab, so parallel workers together stay under the tvoiceai rate limit.
const GLOBAL_TTS_SLOTS = 2;

const stoppedError = () => new DOMException('Đã dừng lồng tiếng theo yêu cầu của bạn.', 'AbortError');
const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(stoppedError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(stoppedError());
      },
      { once: true },
    );
  });

export async function getTtsApiKey() {
  const stored = await chrome.storage.local.get(SECRETS_KEY);
  return stored[SECRETS_KEY]?.ttsApiKey || '';
}

export async function setTtsApiKey(key) {
  const stored = await chrome.storage.local.get(SECRETS_KEY);
  await chrome.storage.local.set({
    [SECRETS_KEY]: { ...(stored[SECRETS_KEY] || {}), ttsApiKey: key.trim() },
  });
}

async function request(path, apiKey, options = {}) {
  let response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch(`${TTS_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!isRateLimited(response.status) || attempt >= RATE_LIMIT_RETRIES) break;
    await wait(retryDelayMs(attempt, response.headers.get('Retry-After')), options.signal);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false)
    throw new Error(
      `Lỗi dịch vụ lồng tiếng (HTTP ${response.status}): ${body.error || body.message || 'yêu cầu thất bại'}`,
    );
  return body;
}

async function withTtsSlot(signal, task) {
  for (let slot = 0; slot < GLOBAL_TTS_SLOTS; slot++) {
    const result = await navigator.locks.request(`museta-tts-${slot}`, { ifAvailable: true }, async lock =>
      lock ? { value: await task() } : null,
    );
    if (result) return result.value;
  }
  const slot = Math.floor(Math.random() * GLOBAL_TTS_SLOTS);
  return navigator.locks.request(`museta-tts-${slot}`, { signal }, task);
}

export function synthesizeSpeech(text, options = {}) {
  return withTtsSlot(options.signal, () => synthesize(text, options));
}

async function synthesize(text, { voiceId, speed = 1, signal, onProgress } = {}) {
  const apiKey = await getTtsApiKey();
  if (!apiKey) throw new Error('Hãy thêm API key tvoiceai trong Cài đặt → Lồng tiếng trước.');
  if (!String(text || '').trim()) throw new Error('Nội dung lồng tiếng đang trống.');
  const job = await request('/api/tts', apiKey, {
    method: 'POST',
    body: JSON.stringify({ text, voice_id: voiceId, speed: Number(speed) || 1, format: 'mp3' }),
    signal,
  });
  if (!job.jobId) throw new Error('Dịch vụ lồng tiếng không trả về ID công việc.');
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await wait(POLL_MS, signal);
    const status = await request(`/api/status/${encodeURIComponent(job.jobId)}`, apiKey, { signal });
    onProgress?.(Number(status.progress) || 0, status);
    if (status.status === 'done' && status.audioUrl) {
      const audio = await fetch(status.audioUrl.replace(/^http:/i, 'https:'), { signal });
      if (!audio.ok) throw new Error(`Không tải được file lồng tiếng (HTTP ${audio.status}).`);
      const blob = await audio.blob();
      if (!blob.size) throw new Error('File lồng tiếng bị rỗng.');
      return URL.createObjectURL(blob);
    }
    if (/error|fail/i.test(status.status || ''))
      throw new Error(`Lồng tiếng thất bại: ${status.error || status.status}`);
  }
  throw new Error('Hết thời gian chờ lồng tiếng.');
}
