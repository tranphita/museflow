import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMusePrompt, buildRefusalRetryPrompt, isRatioMismatch } from '../../src/core/prompts.js';
import {
  recordGeneration,
  restoreGeneration,
  removeGeneration,
  mediaRefs,
  MAX_HISTORY,
} from '../../src/core/history.js';

test('image prompt keeps the original section order', () => {
  const prompt = buildMusePrompt({
    mediaType: 'image',
    size: '16:9',
    prompt: 'a fox',
    negativePrompt: 'blur',
    referenceCount: 2,
  });
  assert.equal(
    prompt,
    'a fox\n\nUse the attached reference images as visual guidance; follow the prompt while preserving relevant subject details.\n\nOutput aspect ratio: 16:9. Match this frame shape exactly. Use a wide landscape composition.\n\nAvoid the following (negative prompt): blur',
  );
});

test('video prompt includes audio, continuity, references and fidelity when requested', () => {
  const prompt = buildMusePrompt({
    mediaType: 'video',
    size: '9:16',
    duration: 6,
    prompt: 'a fox runs',
    referenceCount: 1,
    continuityFrame: true,
    again: true,
  });
  const sections = prompt.split('\n\n');
  assert.match(sections[0], /^Create a 9:16 aspect ratio video clip, 6 seconds long\./);
  assert.match(sections[1], /^AUDIO IS REQUIRED/);
  assert.match(sections[2], /^CONTINUITY LOCK/);
  assert.equal(
    sections[3],
    'Use the attached reference image as visual guidance while keeping image 1 as the exact opening frame.',
  );
  assert.equal(sections[4], 'Prompt: a fox runs');
  assert.match(sections[5], /^PROMPT FIDELITY/);
});

test('video prompt omits optional sections', () => {
  const prompt = buildMusePrompt({ mediaType: 'video', size: '1:1', duration: 5, prompt: 'x' });
  assert.doesNotMatch(prompt, /CONTINUITY|reference|Avoid|FIDELITY/);
});

test('refusal retry appends the safe-equivalent instruction', () => {
  assert.match(buildRefusalRetryPrompt('base'), /^base\n\nSAFE EQUIVALENT RETRY:/);
});

test('ratio mismatch tolerates small differences only', () => {
  assert.equal(isRatioMismatch(1920, 1080, '16:9'), false);
  assert.equal(isRatioMismatch(1000, 1000, '16:9'), true);
  assert.equal(isRatioMismatch(0, 0, '16:9'), false);
});

test('generation history keeps newest first, caps its size and can restore or delete', () => {
  const data = {};
  for (let i = 0; i < MAX_HISTORY + 2; i++)
    recordGeneration(data, { asset: { id: `a${i}`, url: `u${i}`, kind: 'image' } }, i);
  assert.equal(data.history.length, MAX_HISTORY);
  assert.equal(data.history[0].id, `a${MAX_HISTORY + 1}`);
  data.asset = data.history[0].asset;

  restoreGeneration(data, 'a5');
  assert.equal(data.asset.id, 'a5');
  assert.equal(data.status, 'success');

  removeGeneration(data, 'a5');
  assert.equal(data.asset.id, `a${MAX_HISTORY + 1}`);
  assert.ok(!data.history.some(entry => entry.id === 'a5'));
});

test('mediaRefs lists every stored media url including history and music', () => {
  const asset = { id: 'a', url: 'blob:a' };
  const data = {
    localDataUrl: 'data:x',
    asset,
    endFrame: { id: 'e', url: 'data:e' },
    music: { id: 'm', url: 'blob:m' },
    history: [{ asset, endFrame: null }, { asset: { id: 'b', url: 'blob:b' } }],
  };
  assert.deepEqual(
    mediaRefs(data).map(ref => `${ref.field}:${ref.id}`),
    ['input:null', 'asset:a', 'endFrame:e', 'music:m', 'asset:a', 'asset:b'],
  );
});
