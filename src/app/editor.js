import { state } from '../core/state.js';
import { nodeDefs, uid, makeNode } from '../core/node-defs.js';
import { nodeById, topoOrder, connectReferenceNode, syncReferenceFanOut } from '../core/graph.js';
import { parseSceneScript } from '../core/scene-script.js';
import { $, setRunStatus } from './dom.js';
import { saveState } from './persistence.js';
import { createUndoSnapshot } from './undo.js';
import { render } from './render.js';
import { ensureDockTimeline, syncTimelineDock, toggleTimeline } from './timeline.js';

export function addNode(type, x = 250 + Math.random() * 220, y = 160 + Math.random() * 180) {
  const dockTimeline =
    type === 'timeline' && state.nodes.find(node => node.type === 'timeline' && node.data?.dockOnly);
  if (dockTimeline) {
    createUndoSnapshot('Add Timeline node');
    dockTimeline.data.dockOnly = false;
    dockTimeline.x = x;
    dockTimeline.y = y;
    render();
    if ($('#timelineDock').classList.contains('collapsed')) toggleTimeline();
    return;
  }
  const data =
    type === 'prompt'
      ? { text: 'Describe what you want Muse to generate...' }
      : type === 'negativePrompt'
        ? { text: 'blurry, low quality, distorted anatomy, extra fingers, text, watermark' }
        : type === 'textAppend'
          ? { text: 'cinematic lighting, detailed composition' }
          : type === 'textConcat'
            ? { separator: ', ' }
            : type === 'imageResize'
              ? { width: 1024, height: 1024, fit: 'cover' }
              : type === 'generateImage'
                ? { model: 'muse-image', size: '1:1', status: 'idle' }
                : type === 'generateVideo'
                  ? { model: 'muse-video', size: '16:9', duration: 5, continuity: false, status: 'idle' }
                  : type === 'timeline'
                    ? { clipOrder: [], durations: {} }
                    : {};
  createUndoSnapshot(`Add ${nodeDefs[type]?.title || 'node'}`);
  const node = { id: uid(type), type, x, y, data };
  state.nodes.push(node);
  if (type === 'references') syncReferenceFanOut(node);
  else if (['generateImage', 'generateVideo'].includes(type)) {
    const references = state.nodes.find(item => item.type === 'references');
    if (references) connectReferenceNode(references, node);
  }
  render();
  if (type === 'timeline') {
    syncTimelineDock();
    if ($('#timelineDock').classList.contains('collapsed')) toggleTimeline();
  }
}

export function addTextNote(x = 250 + Math.random() * 220, y = 160 + Math.random() * 180) {
  createUndoSnapshot('Add text note');
  const note = { id: uid('note'), x, y, text: 'Write a note…', width: 260, height: 160 };
  state.notes.push(note);
  render();
  saveState();
  setRunStatus('Text note added to canvas.', 'ok');
}

export function removeNode(id) {
  const existing = nodeById(id);
  if (!existing) return;
  createUndoSnapshot(`Delete ${nodeDefs[existing.type]?.title || 'node'}`);
  state.nodes = state.nodes.filter(n => n.id !== id);
  state.edges = state.edges.filter(e => e.source !== id && e.target !== id);
  state.selectedNodeIds = state.selectedNodeIds.filter(nodeId => nodeId !== id);
  if (state.selectedNodeId === id) state.selectedNodeId = state.selectedNodeIds.at(-1) || null;
  render();
  syncTimelineDock();
}

export function selectNode(id, { toggle = false, add = false } = {}) {
  let ids = [...state.selectedNodeIds];
  if (toggle) {
    ids = ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id];
  } else if (add) {
    if (!ids.includes(id)) ids.push(id);
  } else ids = [id];
  state.selectedNodeIds = ids;
  state.selectedNodeId = ids.at(-1) || null;
  document
    .querySelectorAll('.node')
    .forEach(el => el.classList.toggle('selected', ids.includes(el.dataset.id)));
}
export function removeSelectedNodes() {
  const ids = new Set(state.selectedNodeIds);
  if (!ids.size && state.selectedNodeId) ids.add(state.selectedNodeId);
  if (!ids.size) return;
  createUndoSnapshot(`Delete ${ids.size} node${ids.size === 1 ? '' : 's'}`);
  state.nodes = state.nodes.filter(node => !ids.has(node.id));
  state.edges = state.edges.filter(edge => !ids.has(edge.source) && !ids.has(edge.target));
  state.selectedNodeIds = [];
  state.selectedNodeId = null;
  render();
  saveState();
}

export function buildSceneNodesFromScript() {
  const status = $('#scriptImportStatus'),
    scenes = parseSceneScript($('#scriptInput').value);
  if (!scenes.length) {
    status.className = 'error';
    status.textContent =
      'No scenes found. Use headings like “CẢNH 1 (0:00–0:07): Title” and add Prompt ảnh or Prompt video.';
    return;
  }
  createUndoSnapshot('Create nodes from script');
  const baseY = Math.max(40, ...state.nodes.filter(node => !node.data?.dockOnly).map(node => node.y + 360)),
    createdVideos = [];
  let made = 0;
  scenes.forEach((scene, index) => {
    const column = index % 4,
      row = Math.floor(index / 4),
      x = 80 + column * 650,
      y = baseY + row * 1100,
      label = `Scene ${scene.number}${scene.title ? `: ${scene.title}` : ''}`;
    let imageNode = null,
      videoNode = null;
    if (scene.imagePrompt) {
      const prompt = makeNode('prompt', x, y);
      prompt.data = { text: scene.imagePrompt, sceneLabel: label };
      const image = makeNode('generateImage', x + 330, y);
      image.data = { model: 'muse-image', size: scene.size, status: 'idle', sceneLabel: label };
      state.nodes.push(prompt, image);
      state.edges.push({
        id: uid('edge'),
        source: prompt.id,
        sourcePort: 'text',
        target: image.id,
        targetPort: 'prompt',
      });
      imageNode = image;
      made += 2;
    }
    if (scene.videoPrompt) {
      const prompt = makeNode('prompt', x, y + 540);
      prompt.data = { text: scene.videoPrompt, sceneLabel: label };
      const requestedDuration = [5, 6, 8, 10].reduce(
        (best, value) => (Math.abs(value - scene.seconds) < Math.abs(best - scene.seconds) ? value : best),
        5,
      );
      videoNode = makeNode('generateVideo', x + 330, y + 540);
      videoNode.data = {
        model: 'muse-video',
        size: scene.size,
        duration: requestedDuration,
        continuity: createdVideos.length > 0,
        status: 'idle',
        sceneLabel: label,
      };
      state.nodes.push(prompt, videoNode);
      state.edges.push({
        id: uid('edge'),
        source: prompt.id,
        sourcePort: 'text',
        target: videoNode.id,
        targetPort: 'prompt',
      });
      if (imageNode)
        state.edges.push({
          id: uid('edge'),
          source: imageNode.id,
          sourcePort: 'image',
          target: videoNode.id,
          targetPort: 'reference',
        });
      made += 2;
      createdVideos.push({ node: videoNode, seconds: scene.seconds });
    }
  });
  let references = state.nodes.find(node => node.type === 'references');
  if (!references) {
    const minX = Math.min(80, ...state.nodes.filter(node => !node.data?.dockOnly).map(node => node.x));
    references = makeNode('references', minX - 360, baseY);
    references.data = {};
    state.nodes.push(references);
    made++;
  }
  syncReferenceFanOut(references);
  const timeline = ensureDockTimeline();
  timeline.data.clipOrder = createdVideos.map(item => item.node.id);
  timeline.data.durations = timeline.data.durations || {};
  createdVideos.forEach(({ node, seconds }) => {
    timeline.data.durations[node.id] = seconds;
  });
  $('#scriptModal').classList.add('hidden');
  render();
  saveState();
  if ($('#timelineDock').classList.contains('collapsed')) toggleTimeline();
  setRunStatus(
    `Created ${scenes.length} scenes · ${made} nodes · ${createdVideos.length} video clips ordered on the Timeline.`,
    'ok',
  );
}

export function arrangeNodes() {
  try {
    const order = topoOrder().filter(id => !nodeById(id)?.data?.dockOnly),
      level = new Map(order.map(id => [id, 0]));
    for (const id of order)
      for (const edge of state.edges.filter(e => e.source === id && level.has(e.target)))
        level.set(edge.target, Math.max(level.get(edge.target) || 0, (level.get(id) || 0) + 1));
    const groups = new Map();
    for (const id of order) {
      const l = level.get(id) || 0;
      if (!groups.has(l)) groups.set(l, []);
      groups.get(l).push(id);
    }
    createUndoSnapshot('Arrange nodes');
    for (const [l, ids] of groups.entries())
      ids.forEach((id, row) => {
        const node = nodeById(id);
        node.x = 70 + l * 350;
        node.y = 60 + row * 260;
      });
    render();
    setRunStatus('Nodes arranged by workflow order.', 'ok');
  } catch (error) {
    setRunStatus(error.message, 'error');
  }
}
