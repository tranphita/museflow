const TTS_BASE = 'https://tvoiceai.com';
const SECRETS_KEY = 'museta-secrets';
const POLL_MS = 2000;
const TIMEOUT_MS = 5 * 60 * 1000;

const stoppedError = () => new DOMException('Voiceover stopped by user.', 'AbortError');
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
  const response = await fetch(`${TTS_BASE}${path}`, {
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
      `Voiceover service error (HTTP ${response.status}): ${body.error || body.message || 'request failed'}`,
    );
  return body;
}

export async function synthesizeSpeech(text, { voiceId, speed = 1, signal, onProgress } = {}) {
  const apiKey = await getTtsApiKey();
  if (!apiKey) throw new Error('Add your tvoiceai API key in Settings → Voiceover first.');
  if (!String(text || '').trim()) throw new Error('Voiceover text is empty.');
  const job = await request('/api/tts', apiKey, {
    method: 'POST',
    body: JSON.stringify({ text, voice_id: voiceId, speed: Number(speed) || 1, format: 'mp3' }),
    signal,
  });
  if (!job.jobId) throw new Error('Voiceover service did not return a job id.');
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await wait(POLL_MS, signal);
    const status = await request(`/api/status/${encodeURIComponent(job.jobId)}`, apiKey, { signal });
    onProgress?.(Number(status.progress) || 0, status);
    if (status.status === 'done' && status.audioUrl) {
      const audio = await fetch(status.audioUrl.replace(/^http:/i, 'https:'), { signal });
      if (!audio.ok) throw new Error(`Could not download the voiceover (HTTP ${audio.status}).`);
      const blob = await audio.blob();
      if (!blob.size) throw new Error('The voiceover file is empty.');
      return URL.createObjectURL(blob);
    }
    if (/error|fail/i.test(status.status || ''))
      throw new Error(`Voiceover failed: ${status.error || status.status}`);
  }
  throw new Error('Timed out waiting for the voiceover.');
}
