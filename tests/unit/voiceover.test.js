import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSceneScript,
  parseVoiceId,
  parseVoices,
  parseVoiceLines,
  voiceFor,
} from '../../src/core/scene-script.js';
import { workflowFromScript } from '../../src/core/film-graph.js';
import {
  buildEncodeArgs,
  canJoinWithoutReencode,
  clipLengthForVoices,
  scheduleVoices,
} from '../../src/core/ffmpeg-plan.js';
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

test('voice lines are scheduled one after another and the clip grows to fit them', () => {
  assert.deepEqual(scheduleVoices([]), { offsets: [], length: 0 });
  assert.deepEqual(scheduleVoices([2, 3]), { offsets: [0.2, 2.55], length: 5.85 });
  assert.equal(clipLengthForVoices(6, []), 6);
  assert.equal(clipLengthForVoices(6, [2, 3]), 6);
  assert.equal(clipLengthForVoices(6, [3, 4]), 7.85);
  assert.equal(clipLengthForVoices(6, [90]), 60);
});

test('dialogue lines are delayed into place and mixed over the lowered clip audio', () => {
  const clips = [
    clip({
      voices: [
        { path: '/voice_000_0.bin', offset: 0.2 },
        { path: '/voice_000_1.bin', offset: 2.55 },
      ],
    }),
    clip({ hasAudio: false }),
  ];
  assert.equal(canJoinWithoutReencode(clips), false);
  const args = buildEncodeArgs({ clipInfo: clips, inputPaths: ['/0', '/1'], silentInput: '/s.wav' });
  const inputs = args.flatMap((value, index) => (value === '-i' ? [args[index + 1]] : []));
  assert.deepEqual(inputs, ['/0', '/1', '/s.wav', '/voice_000_0.bin', '/voice_000_1.bin']);
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /\[0:a:0\][^;]*,volume=0\.35\[bed0\]/);
  assert.match(filter, /\[3:a:0\][^;]*adelay=200\|200\[voice0_0\]/);
  assert.match(filter, /\[4:a:0\][^;]*adelay=2550\|2550\[voice0_1\]/);
  assert.match(
    filter,
    /\[bed0\]\[voice0_0\]\[voice0_1\]amix=inputs=3:duration=first:dropout_transition=0,volume=3\[a0\]/,
  );
  assert.match(filter, /\[2:a:0\][^;]*atrim=duration=6\.000\[a1\]/);
});

test('speaker lines get their own voice and fall back to the series voice', () => {
  const lines = parseVoiceLines(
    '- Hảo: "Good morning, honey!"\n- Phi Ta: Good morning!\nNarrator text\ncontinues here',
    ['Hảo', 'Phi Ta'],
  );
  assert.deepEqual(lines, [
    { speaker: 'Hảo', text: 'Good morning, honey!' },
    { speaker: 'Phi Ta', text: 'Good morning!' },
    { speaker: '', text: 'Narrator text continues here' },
  ]);
  const voices = parseVoices('GIỌNG ĐỌC: DEFAULT_1\nGIỌNG ĐỌC Phi Ta: TA_VOICE\n\nCẢNH 1 (0:00–0:05): x');
  assert.deepEqual(voices, { default: 'DEFAULT_1', byName: { 'phi ta': 'TA_VOICE' } });
  assert.equal(voiceFor(voices, 'Phi Ta'), 'TA_VOICE');
  assert.equal(voiceFor(voices, 'Hảo'), 'DEFAULT_1');
  assert.equal(voiceFor(voices, ''), 'DEFAULT_1');
});

test('a dialogue scene becomes one voiceover per line wired in order', () => {
  const workflow = workflowFromScript(`GIỌNG ĐỌC: HAO_VOICE
GIỌNG ĐỌC Phi Ta: TA_VOICE

NHÂN VẬT:
- Hảo: woman
- Phi Ta: man

CẢNH 1 (0:00–0:08): Chào
Nhân vật: Hảo, Phi Ta
Prompt video: They greet each other
Lời thoại:
- Hảo: Good morning!
- Phi Ta: Good morning, honey!`);
  const video = workflow.nodes.find(node => node.type === 'generateVideo');
  const voices = workflow.edges
    .filter(edge => edge.target === video.id && edge.targetPort === 'voice')
    .map(edge => workflow.nodes.find(node => node.id === edge.source).data);
  assert.deepEqual(
    voices.map(voice => [voice.speaker, voice.voiceId, voice.text]),
    [
      ['Hảo', 'HAO_VOICE', 'Good morning!'],
      ['Phi Ta', 'TA_VOICE', 'Good morning, honey!'],
    ],
  );
});
