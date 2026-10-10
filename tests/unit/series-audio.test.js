import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClipAudio, parseMusic } from '../../src/core/scene-script.js';
import { workflowFromScript } from '../../src/core/film-graph.js';
import { buildEncodeArgs, canJoinWithoutReencode } from '../../src/core/ffmpeg-plan.js';
import { checkSeries } from '../../src/core/script-check.js';

const scene = '\n\nCẢNH 1 (0:00–0:06): A\nPrompt video: x\n\nCẢNH 2 (0:06–0:12): B\nPrompt video: y';

test('the series can mute every clip sound', () => {
  assert.equal(parseClipAudio('ÂM THANH CLIP: tắt'), 'mute');
  assert.equal(parseClipAudio('CLIP AUDIO: off'), 'mute');
  assert.equal(parseClipAudio('ÂM THANH CLIP: giữ'), 'keep');
  assert.equal(parseClipAudio('TÊN BỘ: x'), 'keep');
  assert.equal(parseClipAudio(`TÊN BỘ: x${scene}\nÂM THANH CLIP: tắt`), 'keep');
});

test('the series names its background music and volume', () => {
  assert.deepEqual(parseMusic('NHẠC NỀN: nhac-nen.mp3\nÂM LƯỢNG NHẠC: 20%'), {
    file: 'nhac-nen.mp3',
    volume: 0.2,
  });
  assert.deepEqual(parseMusic('BACKGROUND MUSIC: song.m4a\nMUSIC VOLUME: 0.15'), {
    file: 'song.m4a',
    volume: 0.15,
  });
  assert.deepEqual(parseMusic('NHẠC NỀN: a b.mp3'), { file: 'a b.mp3', volume: 0.25 });
  assert.deepEqual(parseMusic('NHẠC NỀN: a.mp3\nÂM LƯỢNG NHẠC: 300'), { file: 'a.mp3', volume: 1 });
  assert.equal(parseMusic('TÊN BỘ: x'), null);
});

test('the timeline mutes clips and carries the series music', () => {
  const script = `ÂM THANH CLIP: tắt\nNHẠC NỀN: nhac.mp3\nÂM LƯỢNG NHẠC: 0.2${scene}`;
  const music = { name: 'nhac.mp3', url: 'data:audio/mpeg;base64,AAAA' };
  const timeline = workflowFromScript(script, { music }).nodes.find(node => node.type === 'timeline');
  assert.equal(timeline.data.clipAudio, 'mute');
  assert.equal(timeline.data.music.url, music.url);
  assert.equal(timeline.data.music.name, 'nhac.mp3');
  assert.equal(timeline.data.music.volume, 0.2);
  assert.ok(timeline.data.music.id);
  const plain = workflowFromScript(`TÊN BỘ: x${scene}`).nodes.find(node => node.type === 'timeline');
  assert.equal(plain.data.clipAudio, undefined);
  assert.equal(plain.data.music, undefined);
});

const clip = (overrides = {}) => ({
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

test('muted clips use silence instead of their own sound', () => {
  const clips = [clip({ voices: [{ path: '/voice_000_0.bin', offset: 0.2 }] }), clip()];
  assert.equal(canJoinWithoutReencode([clip(), clip()], { muteClipAudio: true }), false);
  const args = buildEncodeArgs({
    clipInfo: clips,
    inputPaths: ['/0', '/1'],
    silentInput: '/s.wav',
    muteClipAudio: true,
  });
  const inputs = args.flatMap((value, index) => (value === '-i' ? [args[index + 1]] : []));
  assert.deepEqual(inputs, ['/0', '/1', '/s.wav', '/s.wav', '/voice_000_0.bin']);
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.doesNotMatch(filter, /\[0:a:0\]|\[1:a:0\]/);
  assert.match(filter, /\[2:a:0\][^;]*\[bed0\]/);
  assert.match(filter, /\[3:a:0\][^;]*\[a1\]/);
});

test('the series warns when its music file is missing', () => {
  const bible = 'NHẠC NỀN: nhac.mp3\n\nLUẬT:\n- An: luôn cười\n\nNHÂN VẬT:\n- An: a';
  const missing = checkSeries(bible, { photoNames: ['An'] }).map(issue => issue.message);
  assert.ok(missing.some(message => /nhac\.mp3/.test(message)));
  assert.deepEqual(checkSeries(bible, { photoNames: ['An'], musicFound: true }), []);
});
