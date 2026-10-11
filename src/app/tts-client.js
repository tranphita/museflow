import { isRateLimited, retryDelayMs } from '../core/rate-limit.js';
import {
  DEFAULT_ELEVENLABS_MODEL,
  TTS_PROVIDERS,
  elevenLabsSpeed,
  normalizeProvider,
  resolveTtsVoice,
} from '../core/tts-voice.js';

const TTS_BASE = 'https://tvoiceai.com';
const ELEVENLABS_BASE = 'https://api.elevenlabs.io';
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

export async function getTtsSettings() {
  const stored = (await chrome.storage.local.get(SECRETS_KEY))[SECRETS_KEY] || {};
  return {
    provider: normalizeProvider(stored.ttsProvider),
    tvoiceaiKey: stored.ttsApiKey || '',
    elevenKey: stored.elevenApiKey || '',
    elevenModel: stored.elevenModel || DEFAULT_ELEVENLABS_MODEL,
    elevenVoiceId: stored.elevenVoiceId || '',
  };
}

export async function saveTtsSettings({ provider, tvoiceaiKey, elevenKey, elevenModel, elevenVoiceId }) {
  const stored = (await chrome.storage.local.get(SECRETS_KEY))[SECRETS_KEY] || {};
  await chrome.storage.local.set({
    [SECRETS_KEY]: {
      ...stored,
      ttsProvider: normalizeProvider(provider),
      ...(tvoiceaiKey?.trim() ? { ttsApiKey: tvoiceaiKey.trim() } : {}),
      ...(elevenKey?.trim() ? { elevenApiKey: elevenKey.trim() } : {}),
      elevenModel: elevenModel || DEFAULT_ELEVENLABS_MODEL,
      elevenVoiceId: String(elevenVoiceId || '').trim(),
    },
  });
}

const keyFor = (settings, provider) =>
  provider === 'elevenlabs' ? settings.elevenKey : settings.tvoiceaiKey;

export async function missingTtsKeyProvider(voiceIds = ['']) {
  const settings = await getTtsSettings();
  const providers = voiceIds.map(id => resolveTtsVoice(id, settings).provider);
  return providers.find(provider => !keyFor(settings, provider)) || '';
}

async function fetchWithRateLimit(url, options) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, options);
    if (!isRateLimited(response.status) || attempt >= RATE_LIMIT_RETRIES) return response;
    await wait(retryDelayMs(attempt, response.headers.get('Retry-After')), options.signal);
  }
}

async function request(path, apiKey, options = {}) {
  const response = await fetchWithRateLimit(`${TTS_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
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
  if (!String(text || '').trim()) throw new Error('Nội dung lồng tiếng đang trống.');
  const settings = await getTtsSettings();
  const voice = resolveTtsVoice(voiceId, settings);
  const apiKey = keyFor(settings, voice.provider);
  if (!apiKey)
    throw new Error(
      `Hãy thêm API key ${TTS_PROVIDERS[voice.provider].label} trong Cài đặt → Lồng tiếng trước.`,
    );
  return voice.provider === 'elevenlabs'
    ? synthesizeElevenLabs(text, {
        apiKey,
        voiceId: voice.voiceId,
        model: settings.elevenModel,
        speed,
        signal,
      })
    : synthesizeTvoiceai(text, { apiKey, voiceId: voice.voiceId, speed, signal, onProgress });
}

async function synthesizeElevenLabs(text, { apiKey, voiceId, model, speed, signal }) {
  const response = await fetchWithRateLimit(
    `${ELEVENLABS_BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: model, voice_settings: { speed: elevenLabsSpeed(speed) } }),
      signal,
    },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = body.detail?.message || body.detail?.status || body.detail || body.message;
    throw new Error(
      `Lỗi dịch vụ lồng tiếng (HTTP ${response.status}): ElevenLabs ${typeof detail === 'string' ? detail : 'yêu cầu thất bại'}`,
    );
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error('File lồng tiếng bị rỗng.');
  return URL.createObjectURL(blob);
}

async function synthesizeTvoiceai(text, { apiKey, voiceId, speed, signal, onProgress }) {
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
      throw new Error(
        `Lồng tiếng tvoiceai thất bại với giọng ${voiceId}: ${status.error || status.message || status.status}. Kiểm tra voice ID và credit tvoiceai, hoặc dùng voice ID ElevenLabs.`,
      );
  }
  throw new Error('Hết thời gian chờ lồng tiếng.');
}
