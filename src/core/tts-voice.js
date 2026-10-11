import { DEFAULT_VOICE_ID } from './node-defs.js';

export const TTS_PROVIDERS = {
  elevenlabs: { label: 'ElevenLabs', defaultVoiceId: 'JBFqnCBsd6RMkjVDRZzb' },
  tvoiceai: { label: 'tvoiceai', defaultVoiceId: DEFAULT_VOICE_ID },
};
export const DEFAULT_TTS_PROVIDER = 'elevenlabs';
export const ELEVENLABS_MODELS = [
  ['eleven_multilingual_v2', 'Multilingual v2 (chất lượng cao, 2 luồng ở gói free)'],
  ['eleven_turbo_v2_5', 'Turbo v2.5 (nhanh, có tiếng Việt, 4 luồng ở gói free)'],
  ['eleven_flash_v2_5', 'Flash v2.5 (nhanh nhất, rẻ nhất, 4 luồng ở gói free)'],
  ['eleven_v3', 'Eleven v3 (biểu cảm nhất)'],
];
export const DEFAULT_ELEVENLABS_MODEL = ELEVENLABS_MODELS[0][0];

const ELEVENLABS_VOICE_ID = /^[A-Za-z0-9]{20}$/;

export const normalizeProvider = provider => (TTS_PROVIDERS[provider] ? provider : DEFAULT_TTS_PROVIDER);

export function resolveTtsVoice(voiceId, { provider, elevenVoiceId } = {}) {
  const id = String(voiceId || '').trim();
  const fallbackProvider = normalizeProvider(provider);
  if (!id || id === DEFAULT_VOICE_ID) {
    const custom = fallbackProvider === 'elevenlabs' ? String(elevenVoiceId || '').trim() : '';
    return { provider: fallbackProvider, voiceId: custom || TTS_PROVIDERS[fallbackProvider].defaultVoiceId };
  }
  return { provider: ELEVENLABS_VOICE_ID.test(id) ? 'elevenlabs' : 'tvoiceai', voiceId: id };
}

export const elevenLabsSpeed = speed => Math.min(1.2, Math.max(0.7, Number(speed) || 1));

// ElevenLabs free-plan concurrency (https://elevenlabs.io/docs/models): Flash/Turbo 4, other models 2.
const FAST_ELEVENLABS_MODEL = /^eleven_(?:flash|turbo)_/;

export const ttsConcurrency = (provider, model = '') =>
  provider === 'elevenlabs' && FAST_ELEVENLABS_MODEL.test(model) ? 4 : 2;
