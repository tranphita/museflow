import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canJoinWithoutReencode,
  buildEncodeArgs,
  buildConcatList,
  outputFrameSize,
  TIMELINE_OUTPUT,
} from '../../src/core/ffmpeg-plan.js';

const clip = (overrides = {}) => ({
  hasAudio: true,
  width: 1920,
  height: 1080,
  videoCodec: 'h264',
  videoProfile: 'High',
  pixelFormat: 'yuv420p',
  audioCodec: 'aac',
  audioRate: 48000,
  audioChannels: 2,
  sourceDuration: 5,
  duration: 5,
  ...overrides,
});

test('matching H.264/AAC clips are joined without re-encoding unless music is added', () => {
  assert.equal(canJoinWithoutReencode([clip(), clip()]), true);
  assert.equal(canJoinWithoutReencode([clip(), clip()], { hasMusic: true }), false);
  assert.equal(canJoinWithoutReencode([clip(), clip({ width: 1280 })]), false);
  assert.equal(canJoinWithoutReencode([clip({ duration: 3 })]), false);
  assert.equal(canJoinWithoutReencode([]), false);
});

test('concat list quotes each input', () => {
  assert.equal(buildConcatList(['/a.bin', '/b.bin']), "file '/a.bin'\nfile '/b.bin'\n");
});

test('output frame is capped at 1280 and kept even', () => {
  assert.deepEqual(outputFrameSize([clip()]), { width: 1280, height: 720 });
  assert.deepEqual(outputFrameSize([clip({ width: 721, height: 1281 })]), { width: 720, height: 1280 });
});

test('silent clips get a looped silence input in clip order', () => {
  const args = buildEncodeArgs({
    clipInfo: [clip({ hasAudio: false }), clip(), clip({ hasAudio: false })],
    inputPaths: ['/0', '/1', '/2'],
    silentInput: '/silence.wav',
  });
  const inputs = args.flatMap((value, index) => (value === '-i' ? [args[index + 1]] : []));
  assert.deepEqual(inputs, ['/0', '/1', '/2', '/silence.wav', '/silence.wav']);
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /\[3:a:0\][^;]*\[a0\]/);
  assert.match(filter, /\[1:a:0\][^;]*\[a1\]/);
  assert.match(filter, /\[4:a:0\][^;]*\[a2\]/);
  assert.equal(args[args.indexOf('-map', args.indexOf('-map') + 1) + 1], '[clipa]');
  assert.equal(args.at(-1), TIMELINE_OUTPUT);
});

test('background music is looped, trimmed to the timeline, faded and mixed', () => {
  const args = buildEncodeArgs({
    clipInfo: [clip({ duration: 4 }), clip({ hasAudio: false, duration: 6 })],
    inputPaths: ['/0', '/1'],
    silentInput: '/silence.wav',
    music: { path: '/music.bin', volume: 0.5 },
  });
  const inputs = args.flatMap((value, index) => (value === '-i' ? [args[index + 1]] : []));
  assert.deepEqual(inputs, ['/0', '/1', '/silence.wav', '/music.bin']);
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /\[3:a:0\][^;]*atrim=duration=10\.000,volume=0\.50,afade=t=out:st=8\.500:d=1\.5\[music\]/);
  assert.match(filter, /\[clipa\]\[music\]amix=inputs=2/);
  const maps = args.flatMap((value, index) => (value === '-map' ? [args[index + 1]] : []));
  assert.deepEqual(maps, ['[outv]', '[mixa]']);
});
