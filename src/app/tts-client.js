import { isRateLimited, retryDelayMs } from '../core/rate-limit.js';
import {
  DEFAULT_ELEVENLABS_MODEL,
  TTS_PROVIDERS,
  elevenLabsSpeed,
  normalizeProvider,
  resolveTtsVoice,
  ttsConcurrency,
} from '../core/tts-voice.js';
import { wordsFromAlignment } from '../core/learning-fx.js';

const TTS_BASE = 'https://tvoiceai.com';
const ELEVENLABS_BASE = 'https://api.elevenlabs.io';
const SECRETS_KEY = 'museta-secrets';
const POLL_MS = 3000;
const TIMEOUT_MS = 5 * 60 * 1000;
const RATE_LIMIT_RETRIES = 6;
const REQUEST_TIMEOUT_MS = 90_000;
const TIMEOUT_RETRIES = 2;
// A slot held this long belongs to a request that can no longer finish (for example a frozen
// worker tab), so a waiting request takes it over instead of stalling every worker forever.
const STALE_SLOT_MS = 2 * REQUEST_TIMEOUT_MS;

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

// Slots are Web Locks shared by every Museta tab, so parallel workers together stay under the
// provider's concurrency limit. A slot is held only while one HTTP request is in flight.
async function withTtsSlot(slots, signal, task) {
  for (let slot = 0; slot < slots; slot++) {
    const result = await navigator.locks.request(`museta-tts-${slot}`, { ifAvailable: true }, async lock =>
      lock ? { value: await task() } : null,
    );
    if (result) return result.value;
  }
  const name = `museta-tts-${Math.floor(Math.random() * slots)}`;
  const waitLimit = AbortSignal.timeout(STALE_SLOT_MS);
  let granted = false;
  const run = () => {
    granted = true;
    return task();
  };
  try {
    return await navigator.locks.request(name, { signal: anySignal(signal, waitLimit) }, run);
  } catch (error) {
    if (granted || signal?.aborted || !waitLimit.aborted) throw error;
    return navigator.locks.request(name, { steal: true }, run);
  }
}

const anySignal = (...signals) => AbortSignal.any(signals.filter(Boolean));

async function fetchOnce(url, options) {
  const response = await fetch(url, {
    ...options,
    signal: anySignal(options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
  });
  return { ok: response.ok, status: response.status, headers: response.headers, blob: await response.blob() };
}

async function fetchTts(url, options, slots) {
  for (let attempt = 0, timeouts = 0; ; attempt++) {
    let reply;
    try {
      reply = await withTtsSlot(slots, options.signal, () => fetchOnce(url, options));
    } catch (error) {
      if (options.signal?.aborted) throw stoppedError();
      if (error?.name !== 'TimeoutError') throw error;
      if (++timeouts > TIMEOUT_RETRIES)
        throw new Error(
          `Hết thời gian chờ dịch vụ lồng tiếng: không có phản hồi sau ${REQUEST_TIMEOUT_MS / 1000} giây (đã thử ${timeouts} lần).`,
        );
      continue;
    }
    if (!isRateLimited(reply.status) || attempt >= RATE_LIMIT_RETRIES) return reply;
    await wait(retryDelayMs(attempt, reply.headers.get('Retry-After')), options.signal);
  }
}

const replyJson = reply =>
  reply.blob
    .text()
    .then(JSON.parse)
    .catch(() => ({}));

async function request(path, apiKey, options = {}) {
  const reply = await fetchTts(
    `${TTS_BASE}${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    },
    ttsConcurrency('tvoiceai'),
  );
  const body = await replyJson(reply);
  if (!reply.ok || body.success === false)
    throw new Error(
      `Lỗi dịch vụ lồng tiếng (HTTP ${reply.status}): ${body.error || body.message || 'yêu cầu thất bại'}`,
    );
  return body;
}

export async function synthesizeSpeech(text, { voiceId, speed = 1, signal, onProgress } = {}) {
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
  const reply = await fetchTts(
    `${ELEVENLABS_BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ text, model_id: model, voice_settings: { speed: elevenLabsSpeed(speed) } }),
      signal,
    },
    ttsConcurrency('elevenlabs', model),
  );
  if (!reply.ok) {
    const body = await replyJson(reply);
    const detail = body.detail?.message || body.detail?.status || body.detail || body.message;
    throw new Error(
      `Lỗi dịch vụ lồng tiếng (HTTP ${reply.status}): ElevenLabs ${typeof detail === 'string' ? detail : 'yêu cầu thất bại'}`,
    );
  }
  const body = await replyJson(reply);
  if (!body.audio_base64) throw new Error('File lồng tiếng bị rỗng.');
  const audio = Uint8Array.from(atob(body.audio_base64), character => character.charCodeAt(0));
  return {
    url: URL.createObjectURL(new Blob([audio], { type: 'audio/mpeg' })),
    words: wordsFromAlignment(body.alignment),
  };
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
      return { url: URL.createObjectURL(blob), words: [] };
    }
    if (/error|fail/i.test(status.status || ''))
      throw new Error(
        `Lồng tiếng tvoiceai thất bại với giọng ${voiceId}: ${status.error || status.message || status.status}. Kiểm tra voice ID và credit tvoiceai, hoặc dùng voice ID ElevenLabs.`,
      );
  }
  throw new Error('Hết thời gian chờ lồng tiếng.');
}
