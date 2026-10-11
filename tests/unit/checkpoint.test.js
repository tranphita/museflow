import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySeriesSettings,
  isJobMediaKey,
  jobMediaPrefix,
  lockFinishedSteps,
  staleMediaKeys,
} from '../../src/core/checkpoint.js';

test('job media keys are namespaced and never pruned by the canvas', () => {
  assert.equal(jobMediaPrefix('job-1'), 'job:job-1:');
  assert.equal(isJobMediaKey('job:job-1:asset:a'), true);
  assert.equal(isJobMediaKey('asset:a'), false);
  assert.deepEqual(staleMediaKeys(['asset:a', 'asset:b', 'job:job-1:asset:c'], new Set(['asset:a'])), [
    'asset:b',
  ]);
});

test('only finished steps with media are locked for the resumed run', () => {
  const node = (id, type, data) => ({ id, type, data });
  const workflow = {
    nodes: [
      node('img', 'generateImage', { status: 'success', asset: { url: 'museta-idb:x' } }),
      node('vid', 'generateVideo', { status: 'error', asset: null }),
      node('run', 'generateVideo', { status: 'running', asset: { url: 'museta-idb:y' } }),
      node('voice', 'voiceover', { status: 'success', asset: { url: 'museta-idb:z' } }),
      node('empty', 'generateImage', { status: 'success', asset: null }),
      node('prompt', 'prompt', { text: 'hi' }),
    ],
    edges: [],
  };
  const result = lockFinishedSteps(workflow);
  assert.equal(result, workflow);
  assert.deepEqual(
    workflow.nodes.filter(item => item.data.locked).map(item => item.id),
    ['img', 'voice'],
  );
});

test('a resumed episode picks up the series subtitle, clip audio and music settings', () => {
  const checkpoint = {
    nodes: [
      {
        id: 'v-old',
        type: 'voiceover',
        data: { sceneLabel: 'Cảnh 1 · Mia · 1', text: 'Hi', status: 'success' },
      },
      {
        id: 'tl-old',
        type: 'timeline',
        data: { clipOrder: ['a'], transition: { type: 'fade', duration: 0.5 } },
      },
    ],
  };
  const fresh = {
    nodes: [
      {
        id: 'v-new',
        type: 'voiceover',
        data: { sceneLabel: 'Cảnh 1 · Mia · 1', text: 'Hi', subtitle: { en: '*Hi*', vi: '*Chào*' } },
      },
      {
        id: 'tl-new',
        type: 'timeline',
        data: {
          subtitles: 'bilingual',
          clipAudio: 'duck',
          music: { id: 'm', url: 'data:audio/mpeg;base64,AA' },
        },
      },
    ],
  };
  const [voice, timeline] = applySeriesSettings(checkpoint, fresh).nodes;
  assert.deepEqual(voice.data.subtitle, { en: '*Hi*', vi: '*Chào*' });
  assert.equal(voice.data.status, 'success');
  assert.deepEqual(timeline.data.clipOrder, ['a']);
  assert.equal(timeline.data.subtitles, 'bilingual');
  assert.equal(timeline.data.clipAudio, 'duck');
  assert.equal(timeline.data.music.url, 'data:audio/mpeg;base64,AA');
  const off = applySeriesSettings(structuredClone(checkpoint), { nodes: [{ type: 'timeline', data: {} }] });
  assert.equal(off.nodes[1].data.subtitles, undefined);
  assert.equal(off.nodes[1].data.clipAudio, undefined);
});
