import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtitleMode, parseVoiceLines, stripHighlights } from '../../src/core/scene-script.js';

test('a bilingual line keeps the marked subtitle and gives TTS only clean English', () => {
  const [line] = parseVoiceLines('- Mommy: Say *Can I have milk?* | Con nói *Con xin sữa ạ?*', ['Mommy']);
  assert.deepEqual(line, {
    speaker: 'Mommy',
    text: 'Say Can I have milk?',
    subtitle: { en: 'Say *Can I have milk?*', vi: 'Con nói *Con xin sữa ạ?*' },
  });
});

test('lines without markup keep their old shape and a bare pipe is not a separator', () => {
  assert.deepEqual(parseVoiceLines('- Mia: Hello!\n- Mommy: a|b', ['Mia', 'Mommy']), [
    { speaker: 'Mia', text: 'Hello!' },
    { speaker: 'Mommy', text: 'a|b' },
  ]);
});

test('an English-only highlight still produces a subtitle without translation', () => {
  const [line] = parseVoiceLines('- Mia: *Where is my* bag?', ['Mia']);
  assert.deepEqual(line, { speaker: 'Mia', text: 'Where is my bag?', subtitle: { en: '*Where is my* bag?', vi: '' } });
});

test('an unpaired asterisk stays as a plain character', () => {
  assert.equal(stripHighlights('5 * 3 = *fifteen*'), '5 * 3 = fifteen');
  assert.deepEqual(parseVoiceLines('- Mia: I got 5* today', ['Mia']), [{ speaker: 'Mia', text: 'I got 5* today' }]);
});

test('continuation lines merge both the spoken text and the subtitle', () => {
  assert.deepEqual(parseVoiceLines('Look at this! | Nhìn này!\nIt is *red* | Nó *màu đỏ*'), [
    {
      speaker: '',
      text: 'Look at this! It is red',
      subtitle: { en: 'Look at this! It is *red*', vi: 'Nhìn này! Nó *màu đỏ*' },
    },
  ]);
  assert.deepEqual(parseVoiceLines('Hello there\nIt is *red* | Nó *màu đỏ*'), [
    { speaker: '', text: 'Hello there It is red', subtitle: { en: 'Hello there It is *red*', vi: 'Nó *màu đỏ*' } },
  ]);
});

test('the series turns bilingual subtitles on with PHỤ ĐỀ or SUBTITLES', () => {
  assert.equal(parseSubtitleMode('PHỤ ĐỀ: song ngữ\n\nCẢNH 1 (0:00–0:05): x'), 'bilingual');
  assert.equal(parseSubtitleMode('SUBTITLES: bilingual'), 'bilingual');
  assert.equal(parseSubtitleMode('TÊN BỘ: x\n\nCẢNH 1 (0:00–0:05): x\nPHỤ ĐỀ: song ngữ'), 'off');
  assert.equal(parseSubtitleMode('PHỤ ĐỀ: tắt'), 'off');
});
