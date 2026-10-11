import { DEFAULT_VOICE_ID } from './node-defs.js';

export const TTS_PROVIDERS = {
  elevenlabs: { label: 'ElevenLabs', defaultVoiceId: 'JBFqnCBsd6RMkjVDRZzb' },
  tvoiceai: { label: 'tvoiceai', defaultVoiceId: DEFAULT_VOICE_ID },
};
export const DEFAULT_TTS_PROVIDER = 'elevenlabs';
export const ELEVENLABS_MODELS = [
  ['eleven_multilingual_v2', 'Multilingual v2 (chất lượng cao)'],
  ['eleven_turbo_v2_5', 'Turbo v2.5 (nhanh, có tiếng Việt)'],
  ['eleven_flash_v2_5', 'Flash v2.5 (nhanh nhất, rẻ nhất)'],
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
