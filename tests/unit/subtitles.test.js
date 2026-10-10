import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtitleMode, parseVoiceLines, stripHighlights } from '../../src/core/scene-script.js';
import { buildAss, buildSubtitleEvents, SUBTITLE_FONT, voiceSubtitle } from '../../src/core/subtitle-plan.js';
import { buildEncodeArgs, canJoinWithoutReencode } from '../../src/core/ffmpeg-plan.js';
import { workflowFromScript } from '../../src/core/film-graph.js';

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
  assert.deepEqual(line, {
    speaker: 'Mia',
    text: 'Where is my bag?',
    subtitle: { en: '*Where is my* bag?', vi: '' },
  });
});

test('an unpaired asterisk stays as a plain character', () => {
  assert.equal(stripHighlights('5 * 3 = *fifteen*'), '5 * 3 = fifteen');
  assert.deepEqual(parseVoiceLines('- Mia: I got 5* today', ['Mia']), [
    { speaker: 'Mia', text: 'I got 5* today' },
  ]);
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
    {
      speaker: '',
      text: 'Hello there It is red',
      subtitle: { en: 'Hello there It is *red*', vi: 'Nó *màu đỏ*' },
    },
  ]);
});

test('the series turns bilingual subtitles on with PHỤ ĐỀ or SUBTITLES', () => {
  assert.equal(parseSubtitleMode('PHỤ ĐỀ: song ngữ\n\nCẢNH 1 (0:00–0:05): x'), 'bilingual');
  assert.equal(parseSubtitleMode('SUBTITLES: bilingual'), 'bilingual');
  assert.equal(parseSubtitleMode('TÊN BỘ: x\n\nCẢNH 1 (0:00–0:05): x\nPHỤ ĐỀ: song ngữ'), 'off');
  assert.equal(parseSubtitleMode('PHỤ ĐỀ: tắt'), 'off');
});

const voice = (offset, duration, en, vi = '') => ({ offset, duration, en, vi });

test('subtitle events follow each clip start on a hard-cut timeline', () => {
  const events = buildSubtitleEvents({
    clips: [
      { duration: 6, voices: [] },
      { duration: 6, voices: [voice(0.2, 2, 'Hello', 'Xin chào')] },
    ],
  });
  assert.deepEqual(events, [{ start: 6.2, end: 8.45, en: 'Hello', vi: 'Xin chào' }]);
});

test('crossfades pull later clips earlier by the blend length', () => {
  const [event] = buildSubtitleEvents({
    clips: [
      { duration: 6, voices: [] },
      { duration: 6, voices: [voice(0, 1, 'Hi')] },
    ],
    transition: { type: 'fade', duration: 0.5 },
  });
  assert.equal(event.start, 5.5);
});

test('a subtitle ends before the next one starts and never passes the timeline end', () => {
  const events = buildSubtitleEvents({
    clips: [
      {
        duration: 5,
        voices: [voice(0.2, 2, 'One'), voice(2.3, 2, 'Two'), voice(4.6, 3, 'Three'), voice(6, 1, 'Late')],
      },
    ],
  });
  assert.deepEqual(
    events.map(({ start, end, en }) => [start, end, en]),
    [
      [0.2, 2.3, 'One'],
      [2.3, 4.55, 'Two'],
      [4.6, 5, 'Three'],
    ],
  );
});

test('voices without words make no subtitle', () => {
  assert.deepEqual(buildSubtitleEvents({ clips: [{ duration: 6, voices: [voice(0.2, 1, '  ')] }] }), []);
});

test('the ASS file sizes text to the frame and paints highlighted phrases', () => {
  const ass = buildAss({
    events: [
      { start: 6.2, end: 8.45, en: '*Can I* go?', vi: '*Con* đi nhé?' },
      { start: 61.5, end: 62, en: 'Bye', vi: '' },
    ],
    width: 720,
    height: 1280,
  });
  assert.match(ass, /PlayResX: 720\nPlayResY: 1280/);
  assert.match(ass, new RegExp(`Style: Default,${SUBTITLE_FONT.name},67,`));
  assert.ok(
    ass.includes(
      String.raw`Dialogue: 0,0:00:06.20,0:00:08.45,Default,,0,0,0,,{\c&H4DD8FF&}Can I{\c&HFFFFFF&} go?\N{\fs49\c&HE6F5FF&}{\c&H4DD8FF&}Con{\c&HE6F5FF&} đi nhé?`,
    ),
  );
  assert.ok(ass.includes('Dialogue: 0,0:01:01.50,0:01:02.00,Default,,0,0,0,,Bye\n'));
});

test('braces, backslashes and line breaks in dialogue stay literal', () => {
  const ass = buildAss({
    events: [{ start: 0, end: 1, en: String.raw`a{b}\c` + '\nnext', vi: '' }],
    width: 720,
    height: 1280,
  });
  assert.ok(ass.includes(',,a\\{b\\}\\⁠c next\n'));
});

const encodeClip = (overrides = {}) => ({
  hasAudio: true,
  width: 720,
  height: 1280,
  videoCodec: 'h264',
  videoProfile: 'High',
  pixelFormat: 'yuv420p',
  audioCodec: 'aac',
  audioRate: 48000,
  audioChannels: 2,
  sourceDuration: 6,
  duration: 6,
  ...overrides,
});

test('subtitles are burned onto the final video and force a re-encode', () => {
  const clips = [encodeClip(), encodeClip()];
  assert.equal(canJoinWithoutReencode(clips), true);
  assert.equal(canJoinWithoutReencode(clips, { hasSubtitles: true }), false);
  const plain = buildEncodeArgs({ clipInfo: clips, inputPaths: ['/0', '/1'], silentInput: '/s.wav' });
  assert.deepEqual(
    buildEncodeArgs({ clipInfo: clips, inputPaths: ['/0', '/1'], silentInput: '/s.wav', subtitles: null }),
    plain,
  );
  const args = buildEncodeArgs({
    clipInfo: clips,
    inputPaths: ['/0', '/1'],
    silentInput: '/s.wav',
    subtitles: { path: '/subs.ass', fontsDir: '/fonts' },
  });
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /;\[outv\]subtitles=filename=\/subs\.ass:fontsdir=\/fonts\[subv\]$/);
  assert.equal(args[args.indexOf('-map') + 1], '[subv]');
});

test('voiceover nodes carry their subtitle and the timeline turns subtitles on', () => {
  const script = `PHỤ ĐỀ: song ngữ
GIỌNG ĐỌC: MOM

NHÂN VẬT:
- Mommy: a mom
- Mia: a girl

CẢNH 1 (0:00–0:07): Sáng
Nhân vật: Mommy, Mia
Prompt video: Breakfast
Lời thoại:
- Mommy: Say *Can I have milk?* | Con nói *Con xin sữa ạ?*
- Mia: Yes!`;
  const workflow = workflowFromScript(script);
  const timeline = workflow.nodes.find(node => node.type === 'timeline');
  assert.equal(timeline.data.subtitles, 'bilingual');
  const [first, second] = workflow.nodes.filter(node => node.type === 'voiceover');
  assert.equal(first.data.text, 'Say Can I have milk?');
  assert.deepEqual(first.data.subtitle, { en: 'Say *Can I have milk?*', vi: 'Con nói *Con xin sữa ạ?*' });
  assert.equal(second.data.subtitle, undefined);
  assert.deepEqual(voiceSubtitle(second.data), { en: 'Yes!', vi: '' });
  assert.deepEqual(voiceSubtitle(first.data), first.data.subtitle);
  const plain = workflowFromScript(script.replace('PHỤ ĐỀ: song ngữ\n', ''));
  assert.equal(plain.nodes.find(node => node.type === 'timeline').data.subtitles, undefined);
});
