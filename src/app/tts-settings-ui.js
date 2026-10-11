import { $ } from './dom.js';
import { ELEVENLABS_MODELS, TTS_PROVIDERS } from '../core/tts-voice.js';
import { getTtsSettings, saveTtsSettings } from './tts-client.js';

const SAVED_KEY_HINT = 'Đã lưu — dán key mới để thay thế';
const keyInputs = { elevenlabs: '#elevenApiKeySetting', tvoiceai: '#ttsApiKeySetting' };

export async function fillTtsSettingsUI() {
  const models = $('#elevenModelSetting');
  if (!models.options.length)
    models.append(
      ...ELEVENLABS_MODELS.map(([value, textContent]) =>
        Object.assign(document.createElement('option'), { value, textContent }),
      ),
    );
  $('#elevenVoiceSetting').placeholder = TTS_PROVIDERS.elevenlabs.defaultVoiceId;
  const tts = await getTtsSettings();
  $('#ttsProviderSetting').value = tts.provider;
  models.value = tts.elevenModel;
  $('#elevenVoiceSetting').value = tts.elevenVoiceId;
  $('#elevenApiKeySetting').placeholder = tts.elevenKey ? SAVED_KEY_HINT : 'sk_…';
  $('#ttsApiKeySetting').placeholder = tts.tvoiceaiKey ? SAVED_KEY_HINT : 'sk_tvoice_…';
}

export async function readTtsSettingsUI() {
  await saveTtsSettings({
    provider: $('#ttsProviderSetting').value,
    tvoiceaiKey: $('#ttsApiKeySetting').value,
    elevenKey: $('#elevenApiKeySetting').value,
    elevenModel: $('#elevenModelSetting').value,
    elevenVoiceId: $('#elevenVoiceSetting').value,
  });
  $('#ttsApiKeySetting').value = '';
  $('#elevenApiKeySetting').value = '';
}

export async function openTtsKeySettings(provider) {
  await fillTtsSettingsUI();
  $('#settingsModal').classList.remove('hidden');
  $(keyInputs[provider] || keyInputs.elevenlabs).focus();
}
