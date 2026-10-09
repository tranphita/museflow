import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../../src/core/state.js';
import {
  getIncoming,
  wouldCreateCycle,
  topoOrder,
  requiredNodeOrder,
  resolvePrompt,
  resolveText,
  resolveNegativePrompt,
  resolveReferences,
  normalizeSavedGraph,
  portCompatible,
  timelinePredecessor,
} from '../../src/core/graph.js';

const node = (id, type, data = {}) => ({ id, type, x: 0, y: 0, data });
const edge = (source, sourcePort, target, targetPort) => ({
  id: `${source}-${target}-${targetPort}`,
  source,
  sourcePort,
  target,
  targetPort,
});

beforeEach(() => {
  state.nodes = [];
  state.edges = [];
  state.groups = [];
  state.notes = [];
});

test('resolvePrompt joins every prompt source and applies Text Append', () => {
  state.nodes = [
    node('p1', 'prompt', { text: 'a cat' }),
    node('ap', 'textAppend', { text: 'cinematic' }),
    node('p2', 'prompt', { text: 'at night' }),
    node('gen', 'generateImage'),
  ];
  state.edges = [
    edge('p1', 'text', 'ap', 'text'),
    edge('ap', 'text', 'gen', 'prompt'),
    edge('p2', 'text', 'gen', 'prompt'),
  ];
  assert.equal(resolvePrompt('gen'), 'a cat cinematic\n\nat night');
});

test('Text Merge joins sources in connection order with its separator', () => {
  state.nodes = [
    node('a', 'prompt', { text: 'red' }),
    node('b', 'prompt', { text: 'blue' }),
    node('m', 'textConcat', { separator: ' | ' }),
  ];
  state.edges = [edge('b', 'text', 'm', 'text'), edge('a', 'text', 'm', 'text')];
  assert.equal(resolveText('m'), 'blue | red');
});

test('negative prompt resolves from the negative input only', () => {
  state.nodes = [node('n', 'negativePrompt', { text: 'blurry' }), node('gen', 'generateImage')];
  state.edges = [edge('n', 'text', 'gen', 'negative')];
  assert.equal(resolveNegativePrompt('gen'), 'blurry');
  assert.equal(resolvePrompt('gen'), '');
});

test('wouldCreateCycle detects loops and ignores the edge being replaced', () => {
  state.nodes = [node('a', 'prompt'), node('b', 'textAppend'), node('c', 'textAppend')];
  state.edges = [edge('a', 'text', 'b', 'text'), edge('b', 'text', 'c', 'text')];
  assert.equal(wouldCreateCycle('c', 'b', null), true);
  assert.equal(wouldCreateCycle('a', 'c', null), false);
});

test('topoOrder respects edges and throws on a cycle', () => {
  state.nodes = [node('gen', 'generateImage'), node('p', 'prompt', { text: 'x' })];
  state.edges = [edge('p', 'text', 'gen', 'prompt')];
  assert.deepEqual(topoOrder(), ['p', 'gen']);
  state.nodes.push(node('t1', 'textAppend'), node('t2', 'textAppend'));
  state.edges.push(edge('t1', 'text', 't2', 'text'), edge('t2', 'text', 't1', 'text'));
  assert.throws(() => topoOrder(), /cycle/);
});

test('topoOrder runs videos in timeline order', () => {
  state.nodes = [
    node('v1', 'generateVideo'),
    node('v2', 'generateVideo'),
    node('tl', 'timeline', { clipOrder: ['v2', 'v1'], durations: {} }),
  ];
  const order = topoOrder();
  assert.ok(order.indexOf('v2') < order.indexOf('v1'));
});

test('continuity makes a video depend on its timeline predecessor', () => {
  state.nodes = [
    node('v1', 'generateVideo'),
    node('v2', 'generateVideo', { continuity: true }),
    node('tl', 'timeline', { clipOrder: ['v1', 'v2'], durations: {} }),
  ];
  assert.equal(timelinePredecessor('v2').id, 'v1');
  assert.deepEqual(requiredNodeOrder('v2'), ['v1', 'v2']);
});

test('requiredNodeOrder only includes upstream nodes', () => {
  state.nodes = [
    node('p', 'prompt', { text: 'x' }),
    node('gen', 'generateImage'),
    node('other', 'prompt', { text: 'y' }),
  ];
  state.edges = [edge('p', 'text', 'gen', 'prompt')];
  assert.deepEqual(requiredNodeOrder('gen'), ['p', 'gen']);
});

test('resolveReferences collects images through a References node without duplicates', () => {
  state.nodes = [
    node('img', 'imageInput', { localDataUrl: 'data:image/png;base64,AA' }),
    node('gen1', 'generateImage', { asset: { kind: 'image', url: 'https://x/1.png', name: 'one' } }),
    node('refs', 'references'),
    node('target', 'generateVideo'),
  ];
  state.edges = [
    edge('img', 'image', 'refs', 'reference1'),
    edge('gen1', 'image', 'refs', 'reference2'),
    edge('refs', 'image', 'target', 'reference'),
    edge('img', 'image', 'target', 'reference'),
  ];
  const refs = resolveReferences('target');
  assert.deepEqual(
    refs.map(r => r.url),
    ['data:image/png;base64,AA', 'https://x/1.png'],
  );
});

test('portCompatible allows image and video into a media input only', () => {
  state.nodes = [node('g', 'generateImage'), node('pv', 'preview'), node('tl', 'timeline')];
  assert.equal(portCompatible({ nodeId: 'g', portId: 'image' }, 'pv', 'media'), true);
  assert.equal(portCompatible({ nodeId: 'g', portId: 'image' }, 'tl', 'clip1'), false);
  assert.equal(portCompatible({ nodeId: 'g', portId: 'image' }, 'g', 'reference'), false);
});

test('normalizeSavedGraph drops unknown nodes, bad edges and converts legacy text nodes to notes', () => {
  state.nodes = [
    node('p', 'prompt', { text: 'x' }),
    node('gen', 'generateImage'),
    node('gen', 'generateImage'),
    node('ghost', 'doesNotExist'),
    node('legacy', 'text', { text: 'hello' }),
    { id: 'nodata', type: 'preview' },
  ];
  state.edges = [
    { source: 'p', target: 'gen' },
    edge('p', 'text', 'ghost', 'x'),
    edge('p', 'text', 'gen', 'reference'),
  ];
  normalizeSavedGraph();
  assert.deepEqual(
    state.nodes.map(n => n.id),
    ['p', 'gen', 'nodata'],
  );
  assert.deepEqual(state.nodes[2].data, {});
  assert.equal(state.edges.length, 1);
  assert.equal(state.edges[0].targetPort, 'prompt');
  assert.equal(state.notes[0].text, 'hello');
});

test('normalizeSavedGraph keeps one source per single input and maps legacy Text Merge ports', () => {
  state.nodes = [
    node('a', 'prompt'),
    node('b', 'prompt'),
    node('neg', 'negativePrompt'),
    node('neg2', 'negativePrompt'),
    node('gen', 'generateImage'),
    node('m', 'textConcat'),
  ];
  state.edges = [
    edge('neg', 'text', 'gen', 'negative'),
    edge('neg2', 'text', 'gen', 'negative'),
    edge('a', 'text', 'm', 'a'),
    edge('b', 'text', 'm', 'b'),
  ];
  normalizeSavedGraph();
  assert.deepEqual(
    getIncoming('gen', 'negative').map(e => e.source),
    ['neg2'],
  );
  assert.deepEqual(
    getIncoming('m', 'text').map(e => e.source),
    ['a', 'b'],
  );
});
