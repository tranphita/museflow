import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTtsVoice, elevenLabsSpeed, ttsConcurrency, TTS_PROVIDERS } from '../../src/core/tts-voice.js';
import { DEFAULT_VOICE_ID } from '../../src/core/node-defs.js';

const ELEVEN_DEFAULT = TTS_PROVIDERS.elevenlabs.defaultVoiceId;

test('an empty or legacy default voice uses ElevenLabs when no provider is chosen', () => {
  for (const voiceId of ['', undefined, '  ', DEFAULT_VOICE_ID])
    assert.deepEqual(resolveTtsVoice(voiceId), { provider: 'elevenlabs', voiceId: ELEVEN_DEFAULT });
});

test('the default voice follows the chosen provider and its custom default voice', () => {
  assert.deepEqual(resolveTtsVoice('', { provider: 'tvoiceai' }), {
    provider: 'tvoiceai',
    voiceId: DEFAULT_VOICE_ID,
  });
  assert.deepEqual(resolveTtsVoice('', { provider: 'elevenlabs', elevenVoiceId: 'EXAVITQu4vr4xnSDxMaL' }), {
    provider: 'elevenlabs',
    voiceId: 'EXAVITQu4vr4xnSDxMaL',
  });
  assert.deepEqual(resolveTtsVoice('', { provider: 'unknown' }), {
    provider: 'elevenlabs',
    voiceId: ELEVEN_DEFAULT,
  });
});

test('an explicit voice id is routed to the provider that owns it', () => {
  assert.deepEqual(resolveTtsVoice('21m00Tcm4TlvDq8ikWAM', { provider: 'tvoiceai' }), {
    provider: 'elevenlabs',
    voiceId: '21m00Tcm4TlvDq8ikWAM',
  });
  assert.deepEqual(resolveTtsVoice('VIENEU_CLONE_42', { provider: 'elevenlabs' }), {
    provider: 'tvoiceai',
    voiceId: 'VIENEU_CLONE_42',
  });
});

test('ElevenLabs speed is kept inside the range the API accepts', () => {
  assert.equal(elevenLabsSpeed(0.5), 0.7);
  assert.equal(elevenLabsSpeed(1.1), 1.1);
  assert.equal(elevenLabsSpeed(2), 1.2);
  assert.equal(elevenLabsSpeed(undefined), 1);
});

test('parallel voice requests follow the ElevenLabs free-plan concurrency per model family', () => {
  assert.equal(ttsConcurrency('elevenlabs', 'eleven_multilingual_v2'), 2);
  assert.equal(ttsConcurrency('elevenlabs', 'eleven_v3'), 2);
  assert.equal(ttsConcurrency('elevenlabs', 'eleven_flash_v2_5'), 4);
  assert.equal(ttsConcurrency('elevenlabs', 'eleven_turbo_v2_5'), 4);
  assert.equal(ttsConcurrency('tvoiceai'), 2);
});
