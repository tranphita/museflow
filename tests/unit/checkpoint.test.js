import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
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
