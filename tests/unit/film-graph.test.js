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
  assert.throws(() => workflowFromScript('NHÂN VẬT:\n- A: b'), /No scenes found/);
});
