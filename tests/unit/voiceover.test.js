import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneScript, parseVoiceId } from '../../src/core/scene-script.js';
import { workflowFromScript } from '../../src/core/film-graph.js';
import { buildEncodeArgs, canJoinWithoutReencode, clipLengthForVoice } from '../../src/core/ffmpeg-plan.js';
import { DEFAULT_VOICE_ID } from '../../src/core/node-defs.js';
import { state } from '../../src/core/state.js';
import { normalizeSavedGraph } from '../../src/core/graph.js';

const script = `GIỌNG ĐỌC: VOICE_TEST_1

CẢNH 1 (0:00–0:06): Mở đầu
Prompt video: A cat walks
Lời thoại: Đừng nói I very like it, hãy nói I really like it.
Audio: soft piano

CẢNH 2 (0:06–0:12): Kết
Prompt video: The cat sleeps`;

test('scene voice lines and the series voice are parsed without leaking into prompts', () => {
  const [first, second] = parseSceneScript(script);
  assert.equal(first.voiceText, 'Đừng nói I very like it, hãy nói I really like it.');
  assert.equal(first.videoPrompt, 'A cat walks\n\nAudio direction: soft piano');
  assert.equal(second.voiceText, '');
  assert.equal(parseVoiceId(script), 'VOICE_TEST_1');
  assert.equal(parseVoiceId('CẢNH 1 (0:00–0:05): x'), '');
});

test('voice lines become voiceover nodes wired to their clip', () => {
  const workflow = structuredClone(workflowFromScript(script));
  const voices = workflow.nodes.filter(node => node.type === 'voiceover');
  assert.equal(voices.length, 1);
  assert.equal(voices[0].data.voiceId, 'VOICE_TEST_1');
  const link = workflow.edges.find(edge => edge.source === voices[0].id);
  assert.equal(link.targetPort, 'voice');
  state.nodes = workflow.nodes;
  state.edges = workflow.edges;
  normalizeSavedGraph();
  assert.ok(state.edges.some(edge => edge.source === voices[0].id && edge.targetPort === 'voice'));
  const fallback = workflowFromScript(script.replace('GIỌNG ĐỌC: VOICE_TEST_1', ''));
  assert.equal(fallback.nodes.find(node => node.type === 'voiceover').data.voiceId, DEFAULT_VOICE_ID);
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

test('a clip grows to fit its narration', () => {
  assert.equal(clipLengthForVoice(6, 0), 6);
  assert.equal(clipLengthForVoice(6, 4), 6);
  assert.equal(clipLengthForVoice(6, 7.25), 7.55);
  assert.equal(clipLengthForVoice(6, 90), 60);
});

test('narration is mixed over the clip audio, which is lowered underneath', () => {
  const clips = [clip({ voicePath: '/voice_000.bin' }), clip({ hasAudio: false })];
  assert.equal(canJoinWithoutReencode(clips), false);
  const args = buildEncodeArgs({ clipInfo: clips, inputPaths: ['/0', '/1'], silentInput: '/s.wav' });
  const inputs = args.flatMap((value, index) => (value === '-i' ? [args[index + 1]] : []));
  assert.deepEqual(inputs, ['/0', '/1', '/s.wav', '/voice_000.bin']);
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /\[0:a:0\][^;]*,volume=0\.35\[bed0\]/);
  assert.match(filter, /\[3:a:0\][^;]*atrim=duration=6\.000\[voice0\]/);
  assert.match(filter, /\[bed0\]\[voice0\]amix=inputs=2:duration=first:dropout_transition=0,volume=2\[a0\]/);
  assert.match(filter, /\[2:a:0\][^;]*atrim=duration=6\.000\[a1\]/);
});
