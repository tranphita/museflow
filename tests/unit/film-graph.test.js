import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workflowFromScript } from '../../src/core/film-graph.js';
import { state } from '../../src/core/state.js';
import { normalizeSavedGraph, topoOrder, resolveReferences } from '../../src/core/graph.js';

const script = readFileSync(new URL('../../docs/sample-film-script.txt', import.meta.url), 'utf8');

test('sample script becomes a complete workflow', () => {
  const workflow = workflowFromScript(script);
  const of = type => workflow.nodes.filter(node => node.type === type);
  assert.equal(of('generateImage').length, 5);
  assert.equal(of('generateVideo').length, 3);
  assert.equal(of('references').length, 1);
  const [timeline] = of('timeline');
  assert.deepEqual(
    timeline.data.clipOrder,
    of('generateVideo').map(node => node.id),
  );
  assert.deepEqual(timeline.data.transition, { type: 'fade', duration: 0.5 });
  assert.deepEqual(workflow.settings, { autoRetry: 0, continueOnError: true });
  assert.equal(workflow.notes.length, 1);
});

test('the generated workflow survives import normalization and runs characters first', () => {
  const workflow = structuredClone(workflowFromScript(script));
  state.nodes = workflow.nodes;
  state.edges = workflow.edges;
  state.groups = workflow.groups;
  state.notes = workflow.notes;
  const edgeCount = state.edges.length;
  normalizeSavedGraph();
  assert.equal(state.edges.length, edgeCount);
  const order = topoOrder();
  const characters = state.nodes.filter(node => node.data.characterName).map(node => node.id);
  const firstScene = state.nodes.find(node => node.type === 'generateImage' && !node.data.characterName);
  for (const id of characters) assert.ok(order.indexOf(id) < order.indexOf(firstScene.id));
  for (const node of state.nodes.filter(item => item.data.characterName))
    node.data.asset = { id: node.id, kind: 'image', url: `data:${node.id}`, name: node.data.characterName };
  assert.deepEqual(
    resolveReferences(firstScene.id).map(ref => ref.character),
    ['Linh', 'Mun'],
  );
});

test('a script without scenes is rejected', () => {
  assert.throws(() => workflowFromScript('NHÂN VẬT:\n- A: b'), /Không tìm thấy cảnh/);
});

test('saved character images replace generated character references', () => {
  const workflow = structuredClone(
    workflowFromScript(script, { characterImages: { linh: 'data:image/png;base64,AA' } }),
  );
  const linh = workflow.nodes.find(node => node.data.characterName === 'Linh');
  const mun = workflow.nodes.find(node => node.data.characterName === 'Mun');
  assert.equal(linh.type, 'imageInput');
  assert.equal(linh.data.localDataUrl, 'data:image/png;base64,AA');
  assert.equal(mun.type, 'generateImage');
  state.nodes = workflow.nodes;
  state.edges = workflow.edges;
  normalizeSavedGraph();
  const firstScene = state.nodes.find(node => node.type === 'generateImage' && !node.data.characterName);
  assert.deepEqual(
    resolveReferences(firstScene.id).map(ref => ref.character),
    ['Linh'],
  );
});

test('several photos of one person all become references for their scenes', () => {
  const photos = [
    'data:image/png;base64,A1',
    'data:image/png;base64,A2',
    'data:image/png;base64,A3',
    'data:x4',
    'data:x5',
  ];
  const workflow = workflowFromScript(script, { characterImages: { Linh: photos } });
  const inputs = workflow.nodes.filter(node => node.data.characterName === 'Linh');
  assert.equal(inputs.length, 4);
  assert.ok(inputs.every(node => node.type === 'imageInput'));
  const firstScene = workflow.nodes.find(node => node.type === 'generateImage' && !node.data.characterName);
  const linkedPhotos = workflow.edges.filter(
    edge => edge.target === firstScene.id && inputs.some(input => input.id === edge.source),
  );
  assert.equal(linkedPhotos.length, 4);
});

test('an AVOID line becomes one negative prompt shared by every generator', () => {
  const workflow = workflowFromScript(`TRÁNH: mặt mập, nọng cằm\n\n${script}`);
  const negatives = workflow.nodes.filter(node => node.type === 'negativePrompt');
  assert.equal(negatives.length, 1);
  assert.equal(negatives[0].data.text, 'mặt mập, nọng cằm');
  const generators = workflow.nodes.filter(node => ['generateImage', 'generateVideo'].includes(node.type));
  const linked = workflow.edges.filter(
    edge => edge.source === negatives[0].id && edge.targetPort === 'negative',
  );
  assert.equal(linked.length, generators.length);
});
