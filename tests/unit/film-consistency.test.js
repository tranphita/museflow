import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSceneScript,
  parseCharacters,
  parseFilmStyle,
  charactersForScene,
  castNote,
  nextShotHint,
} from '../../src/core/scene-script.js';
import { buildMusePrompt, characterLockInstruction } from '../../src/core/prompts.js';
import {
  normalizeTransition,
  timelineLength,
  buildEncodeArgs,
  canJoinWithoutReencode,
} from '../../src/core/ffmpeg-plan.js';

const script = `PHONG CÁCH: hoạt hình 3D ấm áp, ánh sáng hoàng hôn

NHÂN VẬT:
- Linh: cô gái 20 tuổi, tóc ngắn đen, áo khoác vàng
- Mèo Mun: mèo đen mắt xanh, vòng cổ đỏ

Ghi chú khác không phải nhân vật

CẢNH 1 (0:00–0:06): Gặp gỡ
Nhân vật: Linh, Mèo Mun
Prompt ảnh: Linh ngồi trên bậc thềm, Mèo Mun nhảy tới
Prompt video: Linh vươn tay vuốt ve Mèo Mun. Cả hai nhìn nhau.

CẢNH 2 (0:06–0:12): Đi dạo
Prompt video: Mèo Mun chạy dọc con phố

CẢNH 3 (0:12–0:18): Bầu trời
Prompt video: Bầu trời đầy sao
`;

test('parses the cast, stopping at the first blank line', () => {
  assert.deepEqual(parseCharacters(script), [
    { name: 'Linh', description: 'cô gái 20 tuổi, tóc ngắn đen, áo khoác vàng' },
    { name: 'Mèo Mun', description: 'mèo đen mắt xanh, vòng cổ đỏ' },
  ]);
  assert.deepEqual(parseCharacters('CẢNH 1 (0:00–0:05): x\nPrompt video: y'), []);
});

test('parses the film style line', () => {
  assert.equal(parseFilmStyle(script), 'hoạt hình 3D ấm áp, ánh sáng hoàng hôn');
});

test('scene Nhân vật field does not leak into prompts', () => {
  const [first] = parseSceneScript(script);
  assert.deepEqual(first.characterNames, ['Linh', 'Mèo Mun']);
  assert.equal(first.imagePrompt, 'Linh ngồi trên bậc thềm, Mèo Mun nhảy tới');
});

test('scene cast comes from the field, then from mentions, then everyone', () => {
  const cast = parseCharacters(script);
  const [first, second, third] = parseSceneScript(script);
  assert.deepEqual(
    charactersForScene(first, cast).map(c => c.name),
    ['Linh', 'Mèo Mun'],
  );
  assert.deepEqual(
    charactersForScene(second, cast).map(c => c.name),
    ['Mèo Mun'],
  );
  assert.deepEqual(
    charactersForScene(third, cast).map(c => c.name),
    ['Linh', 'Mèo Mun'],
  );
  assert.match(castNote(cast.slice(0, 1)), /^Characters in this shot .*Linh — cô gái/);
});

test('next shot hint uses the next scene title and first sentence', () => {
  const [, second] = parseSceneScript(script);
  assert.equal(nextShotHint(second), 'Đi dạo: Mèo Mun chạy dọc con phố');
  assert.equal(nextShotHint(undefined), '');
});

test('prompts lock connected characters and ask for a flowing ending', () => {
  assert.equal(characterLockInstruction(['', '']), '');
  const video = buildMusePrompt({
    mediaType: 'video',
    size: '9:16',
    duration: 6,
    prompt: 'x',
    referenceCount: 2,
    characterNames: ['Linh', '', 'Linh', 'Mèo Mun'],
    nextShot: 'Đi dạo',
  });
  assert.match(video, /CHARACTER LOCK: The attached character reference images show Linh, Mèo Mun\./);
  assert.match(video, /ENDING: .*\(Đi dạo\)/);
  const image = buildMusePrompt({ mediaType: 'image', size: '1:1', prompt: 'x', characterNames: ['Linh'] });
  assert.match(image, /reference image shows Linh\. Keep this character identical/);
  assert.doesNotMatch(image, /ENDING/);
});

const clip = duration => ({
  hasAudio: true,
  width: 720,
  height: 1280,
  videoCodec: 'h264',
  videoProfile: 'High',
  pixelFormat: 'yuv420p',
  audioCodec: 'aac',
  audioRate: 48000,
  audioChannels: 2,
  sourceDuration: duration,
  duration,
});

test('transition length is clamped to half the shortest clip', () => {
  assert.deepEqual(normalizeTransition({ type: 'fade', duration: 5 }, [6, 3]), {
    type: 'fade',
    duration: 1.5,
  });
  assert.deepEqual(normalizeTransition({ type: 'bogus' }, [6, 6]), { type: 'cut', duration: 0 });
  assert.deepEqual(normalizeTransition({ type: 'fade', duration: 1 }, [6]), { type: 'cut', duration: 0 });
  assert.equal(timelineLength([6, 6, 6], { type: 'fade', duration: 0.5 }), 17);
});

test('transitions chain xfade and acrossfade with cumulative offsets', () => {
  const clips = [clip(6), clip(5), clip(4)];
  assert.equal(canJoinWithoutReencode(clips, { transition: { type: 'fade', duration: 0.5 } }), false);
  const args = buildEncodeArgs({
    clipInfo: clips,
    inputPaths: ['/0', '/1', '/2'],
    silentInput: '/s.wav',
    transition: { type: 'fadeblack', duration: 0.5 },
    music: { path: '/m', volume: 0.4 },
  });
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /\[v0\]\[v1\]xfade=transition=fadeblack:duration=0\.5:offset=5\.500\[xv1\]/);
  assert.match(filter, /\[xv1\]\[v2\]xfade=transition=fadeblack:duration=0\.5:offset=10\.000\[outv\]/);
  assert.match(filter, /\[xa1\]\[a2\]acrossfade=d=0\.5:c1=tri:c2=tri\[clipa\]/);
  assert.match(filter, /atrim=duration=14\.000,volume=0\.40/);
  assert.doesNotMatch(filter, /concat=/);
});
