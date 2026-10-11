import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAudioCues,
  buildCountdowns,
  cueExpression,
  markedWords,
  wordTimings,
  wordsFromAlignment,
} from '../../src/core/learning-fx.js';
import { buildAss, buildSubtitleEvents, karaokeText } from '../../src/core/subtitle-plan.js';
import { buildEncodeArgs } from '../../src/core/ffmpeg-plan.js';
import { parseLearningFx, parseMasterShot } from '../../src/core/scene-script.js';
import { workflowFromScript } from '../../src/core/film-graph.js';
import { state } from '../../src/core/state.js';
import { normalizeSavedGraph, resolveReferences } from '../../src/core/graph.js';
import { buildMusePrompt, lipSyncInstruction } from '../../src/core/prompts.js';

test('ElevenLabs character alignment becomes word timings', () => {
  const alignment = {
    characters: [...'Hi you!'],
    character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
    character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
  };
  assert.deepEqual(wordsFromAlignment(alignment), [
    { text: 'Hi', start: 0, end: 0.2 },
    { text: 'you!', start: 0.3, end: 0.7 },
  ]);
  assert.deepEqual(wordsFromAlignment(undefined), []);
});

test('highlighted phrases mark every word they cover', () => {
  assert.deepEqual(markedWords('*Can I have some* pancakes, *please*?'), [
    { text: 'Can', highlight: true },
    { text: 'I', highlight: true },
    { text: 'have', highlight: true },
    { text: 'some', highlight: true },
    { text: 'pancakes,', highlight: false },
    { text: 'please?', highlight: true },
  ]);
});

test('word timings use spoken timestamps when they line up, otherwise share the line by length', () => {
  const spoken = [
    { text: 'Hi', start: 0.05, end: 0.3 },
    { text: 'Mia!', start: 0.4, end: 0.9 },
  ];
  assert.deepEqual(
    wordTimings('Hi *Mia*!', 1, spoken).map(word => [word.text, word.highlight, word.start, word.end]),
    [
      ['Hi', false, 0.05, 0.3],
      ['Mia!', true, 0.4, 0.9],
    ],
  );
  assert.deepEqual(
    wordTimings('ab abcd', 2).map(word => [word.start, word.end]),
    [
      [0, 0.75],
      [0.75, 2],
    ],
  );
});

test('karaoke text fills each word in turn and keeps the phrase colour distinct', () => {
  const text = karaokeText([
    { text: 'Can', highlight: true, start: 0.1, end: 0.3 },
    { text: 'milk', highlight: false, start: 0.4, end: 0.8 },
  ]);
  assert.equal(text, '{\\k10}{\\kf30\\2c&H4DD8FF&\\1c&H0095FF&}Can {\\kf40\\2c&HFFFFFF&\\1c&H9DF5FF&}milk');
});

test('karaoke subtitles are only built when asked for', () => {
  const clips = [{ duration: 6, voices: [{ offset: 0.2, duration: 1, en: 'Hi *you*', vi: 'Chào' }] }];
  assert.equal(buildSubtitleEvents({ clips })[0].words, undefined);
  const [event] = buildSubtitleEvents({ clips, karaoke: true });
  assert.deepEqual(
    event.words.map(word => word.text),
    ['Hi', 'you'],
  );
  const ass = buildAss({ events: [event], width: 720, height: 1280 });
  assert.match(ass, /Default,,0,0,0,,\{\\kf\d+\\2c&HFFFFFF&\\1c&H9DF5FF&\}Hi \{\\kf/);
  assert.match(ass, /\\N\{\\k0\\fs44\\c&HE6F5FF&\\2c&HE6F5FF&\}Chào/);
});

const pausedClips = [
  { duration: 8, voices: [{ offset: 0.2, duration: 1, en: 'Hello', vi: '' }] },
  {
    duration: 10,
    voices: [
      { offset: 0.2, duration: 2, hold: 3, en: 'Say *milk*', vi: '' },
      { offset: 5.2, duration: 1, en: 'Bye', vi: '' },
    ],
  },
];

test('a pause becomes a countdown that starts when the line ends', () => {
  assert.deepEqual(buildCountdowns({ clips: pausedClips, transition: { type: 'fade', duration: 0.5 } }), [
    { start: 9.7, seconds: 3, length: 3 },
  ]);
  const ass = buildAss({
    events: [],
    width: 720,
    height: 1280,
    countdowns: [{ start: 1, seconds: 3, length: 3 }],
  });
  const lines = ass.split('\n').filter(line => line.includes(',Countdown,'));
  assert.equal(lines.length, 5);
  assert.match(lines[1], /\\t\(0,3000,\\fscx0\)\\p1\}m 0 0 l/);
  assert.match(lines[2], /^Dialogue: 2,0:00:01\.00,0:00:02\.00,.*\}3$/);
  assert.match(lines[4], /^Dialogue: 2,0:00:03\.00,0:00:04\.00,.*\}1$/);
  assert.match(ass, /^Style: Countdown,/m);
});

test('cue sounds pop before highlighted lines and ding when a pause begins', () => {
  assert.deepEqual(buildAudioCues({ clips: pausedClips, fx: ['pop', 'countdown'] }), [
    { kind: 'pop', at: 8.05 },
    { kind: 'ding', at: 10.2 },
  ]);
  assert.deepEqual(buildAudioCues({ clips: pausedClips, fx: [] }), []);
  assert.equal(cueExpression([]), '');
  const expression = cueExpression([{ kind: 'ding', at: 2 }]);
  assert.match(expression, /^between\(t,2,2\.9\)\*\(0\.45\*sin\(2\*PI\*1568\*\(t-2\)\)/);
});

test('cue sounds are mixed over the final soundtrack', () => {
  const clip = {
    hasAudio: true,
    width: 720,
    height: 1280,
    duration: 6,
    sourceDuration: 6,
  };
  const args = buildEncodeArgs({
    clipInfo: [clip],
    inputPaths: ['/a.mp4'],
    silentInput: '/s.wav',
    cueSound: 'between(t,1,1.9)*0.4',
  });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /aevalsrc=exprs='between\(t,1,1\.9\)\*0\.4':s=48000:c=stereo:d=6\.000/);
  assert.match(graph, /\[clipa\]\[cues\]amix=inputs=2:duration=first:dropout_transition=0,volume=2\[cuea\]/);
  assert.equal(args[args.indexOf('-map', args.indexOf('-map') + 1) + 1], '[cuea]');
  const plain = buildEncodeArgs({ clipInfo: [clip], inputPaths: ['/a.mp4'], silentInput: '/s.wav' });
  assert.doesNotMatch(plain.join(' '), /aevalsrc/);
});

const episode = `PHONG CÁCH: hoạt hình 3D kiểu Pixar
HIỆU ỨNG HỌC: karaoke, đếm ngược, pop
NHÂN VẬT:
- Mia: girl

BỐI CẢNH CHÍNH: căn bếp có bàn ăn gỗ, bát dâu tây giữa bàn

CẢNH 1 (0:00–0:08): Bữa sáng
Nhân vật: Mia
Prompt ảnh: Mia ngồi ở bàn
Prompt video: Mia vẫy tay`;

test('the series and episode headers turn on learning effects and a master shot', () => {
  assert.deepEqual(parseLearningFx(episode), ['karaoke', 'countdown', 'pop']);
  assert.deepEqual(parseLearningFx('HIỆU ỨNG HỌC: popcorn'), []);
  assert.equal(parseMasterShot(episode), 'căn bếp có bàn ăn gỗ, bát dâu tây giữa bàn');
  assert.equal(parseMasterShot('CẢNH 1 (0:00–0:08): x\nBỐI CẢNH CHÍNH: muộn'), '');
});

test('the master shot is generated once and handed to every scene image as the set reference', () => {
  const workflow = structuredClone(workflowFromScript(episode));
  const master = workflow.nodes.find(node => node.data.setReference);
  assert.equal(master.type, 'generateImage');
  assert.equal(master.data.sceneLabel, 'Bối cảnh chính');
  const prompt = workflow.nodes.find(
    node =>
      node.id ===
      workflow.edges.find(edge => edge.target === master.id && edge.targetPort === 'prompt').source,
  );
  assert.match(prompt.data.text, /^Master wide shot .*no people.*bát dâu tây/);
  const scene = workflow.nodes.find(
    node => node.type === 'generateImage' && node.data.sceneLabel === 'Cảnh 1: Bữa sáng',
  );
  assert.ok(workflow.edges.some(edge => edge.source === master.id && edge.target === scene.id));
  assert.deepEqual(workflow.nodes.find(node => node.type === 'timeline').data.learningFx, [
    'karaoke',
    'countdown',
    'pop',
  ]);
  state.nodes = workflow.nodes;
  state.edges = workflow.edges;
  normalizeSavedGraph();
  for (const node of state.nodes.filter(item => item.data.characterName || item.data.setReference))
    node.data.asset = { id: node.id, kind: 'image', url: `data:${node.id}`, name: node.id };
  assert.deepEqual(
    resolveReferences(scene.id).map(ref => ref.role),
    ['character', 'set'],
  );
});

test('set references get their own lock and are not called composition guides', () => {
  const prompt = buildMusePrompt({
    mediaType: 'image',
    size: '9:16',
    prompt: 'Mia eats',
    referenceCount: 2,
    characterNames: ['Mia', ''],
    setReferences: [1],
    filmStyle: 'hoạt hình 3D Pixar',
  });
  assert.match(prompt, /SET LOCK — Image #2 is a master shot of this episode's set\. Keep the same room/);
  assert.doesNotMatch(prompt, /composition guide/);
});

test('lip-sync timing also asks for blinking and nodding', () => {
  assert.match(
    lipSyncInstruction([{ speaker: 'Mia', text: 'Hi', start: 0.2, end: 1 }]),
    /\nLIVELY FACES — everyone blinks naturally/,
  );
});
