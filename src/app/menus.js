import { state } from '../core/state.js';
import { nodeDefs, uid, makeNode } from '../core/node-defs.js';
import { nodeById, connectReferenceNode } from '../core/graph.js';
import { $, setRunStatus } from './dom.js';
import { saveState } from './persistence.js';
import { createUndoSnapshot } from './undo.js';
import { addNode, addTextNote, removeNode, removeSelectedNodes, arrangeNodes } from './editor.js';
import { connect } from './connections.js';
import { scheduleDrawEdges, render } from './render.js';
import { playTimeline } from './timeline.js';
import { executeWorkflow, executeGenerationNode, runSingleNode } from './runner.js';

export function openCanvasMenu(e) {
  const nodeEl = e.target.closest('.node');
  e.preventDefault();
  e.stopPropagation();
  if (!nodeEl) {
    const rect = $('#viewport').getBoundingClientRect(),
      menu = $('#canvasMenu');
    state.contextPoint = {
      x: (e.clientX - rect.left - state.panX) / state.zoom,
      y: (e.clientY - rect.top - state.panY) / state.zoom,
    };
    menu.innerHTML = '';
    delete menu.dataset.nodeId;
    const title = document.createElement('div');
    title.className = 'menu-caption';
    title.textContent = 'Canvas';
    menu.appendChild(title);
    [
      ['＋ Prompt', 'add:prompt'],
      ['＋ Text note', 'add:text'],
      ['＋ Negative Prompt', 'add:negativePrompt'],
      ['＋ Image Input', 'add:imageInput'],
      ['＋ References', 'add:references'],
      ['＋ Generate Image', 'add:generateImage'],
      ['＋ Generate Video', 'add:generateVideo'],
      ['＋ Timeline', 'add:timeline'],
      ['＋ Preview', 'add:preview'],
      ['Save workflow', 'save'],
      ['▶ Run workflow', 'run'],
      ['Arrange nodes', 'arrange'],
      ['Delete selected node', 'delete-selected'],
      ['Remove all connections', 'disconnect-all'],
    ].forEach(([label, action]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.contextAction = action;
      menu.appendChild(button);
    });
    menu.classList.remove('hidden');
    menu.style.left = `${Math.min(e.clientX, innerWidth - 230)}px`;
    menu.style.top = `${Math.min(e.clientY, innerHeight - 420)}px`;
    return;
  }
  e.stopPropagation();
  const node = nodeById(nodeEl.dataset.id);
  if (!node) return;
  state.selectedNodeId = node.id;
  const menu = $('#canvasMenu');
  menu.innerHTML = '';
  menu.dataset.nodeId = node.id;
  const title = document.createElement('div');
  title.className = 'menu-caption';
  title.textContent = node.data.customName || nodeDefs[node.type].title;
  menu.appendChild(title);
  const addAction = (label, action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.contextAction = action;
    menu.appendChild(button);
  };
  addAction('Rename node…', 'node-rename');
  if (['generateImage', 'generateVideo'].includes(node.type))
    addAction(
      node.data.status === 'running'
        ? `■ Stop ${node.type === 'generateVideo' ? 'Video' : 'Image'}`
        : `▶ Run ${node.type === 'generateVideo' ? 'Video' : 'Image'}`,
      'node-run',
    );
  if (node.type === 'generateVideo') addAction('↻ Again · follow prompt more closely', 'node-again');
  if (node.type === 'timeline') addAction('▶ Preview sequence', 'node-preview');
  if ((nodeDefs[node.type]?.outputs || []).some(port => port.type === 'text'))
    addAction('Create Text Merge node', 'node-create-text-merge');
  if ((nodeDefs[node.type]?.outputs || []).some(port => ['image', 'video'].includes(port.type)))
    addAction('Create Preview node', 'node-create-preview');
  if (node.type === 'imageInput') addAction('Choose / replace image', 'node-choose-image');
  if (node.type === 'imageResize') addAction('Download resized image', 'node-download-image');
  if (node.type === 'generateImage' && node.data.asset?.url)
    addAction(node.data.characterName ? 'Save character image' : 'Download image', 'node-download-image');
  if (node.type === 'preview') addAction('Download preview', 'node-download-preview');
  if (node.type === 'prompt' || node.type === 'negativePrompt' || node.type === 'textAppend')
    addAction('Focus text field', 'node-focus-text');
  addAction('Duplicate node', 'node-duplicate');
  addAction('Disconnect node', 'node-disconnect');
  addAction('Delete node', 'node-delete');
  menu.classList.remove('hidden');
  menu.style.left = `${Math.min(e.clientX, innerWidth - 230)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - 380)}px`;
}
export function openEdgeMenu(e) {
  const hit = e.target.closest('.edge-hit[data-edge-id]');
  if (!hit) return;
  e.preventDefault();
  e.stopPropagation();
  const menu = $('#canvasMenu');
  menu.innerHTML = '';
  menu.dataset.edgeId = hit.dataset.edgeId;
  delete menu.dataset.nodeId;
  const title = document.createElement('div');
  title.className = 'menu-caption';
  title.textContent = 'Connection';
  menu.appendChild(title);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Delete connection';
  button.dataset.contextAction = 'edge-delete';
  menu.appendChild(button);
  menu.classList.remove('hidden');
  menu.style.left = `${Math.min(e.clientX, innerWidth - 230)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - 120)}px`;
}
export function selectEdgePointer(e) {
  if (e.button !== 0) return;
  const hit = e.target.closest('.edge-hit[data-edge-id]');
  if (!hit) return;
  e.preventDefault();
  e.stopPropagation();
  const id = hit.dataset.edgeId;
  state.selectedEdgeIds = e.shiftKey ? [...new Set([...state.selectedEdgeIds, id])] : [id];
  scheduleDrawEdges();
}
export function closeCanvasMenu() {
  $('#canvasMenu').classList.add('hidden');
}
export function runNodeContextAction(action) {
  const menu = $('#canvasMenu'),
    node = nodeById(menu.dataset.nodeId);
  if (!node) return;
  closeCanvasMenu();
  if (action === 'node-rename') {
    const current =
        node.data.customName ||
        `${nodeDefs[node.type].title}${node.data.sceneLabel ? ` · ${node.data.sceneLabel}` : ''}`,
      name = window.prompt('Enter a name for this node:', current);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setRunStatus('Node name cannot be empty.', 'warn');
      return;
    }
    createUndoSnapshot('Rename node');
    node.data.customName = trimmed;
    render();
    saveState();
    setRunStatus('Node renamed.', 'ok');
    return;
  }
  if (action === 'node-run') {
    runSingleNode(node.id);
    return;
  }
  if (action === 'node-again') {
    executeGenerationNode(node.id, { again: true });
    return;
  }
  if (action === 'node-preview') {
    playTimeline(node);
    return;
  }
  if (action === 'node-delete') {
    removeNode(node.id);
    return;
  }
  if (action === 'node-create-text-merge') {
    const output = (nodeDefs[node.type]?.outputs || []).find(port => port.type === 'text');
    if (!output) return;
    createUndoSnapshot('Create Text Merge node');
    const target = makeNode('textConcat', node.x + 350, node.y);
    target.data = { separator: ', ' };
    state.nodes.push(target);
    state.edges.push({
      id: uid('edge'),
      source: node.id,
      sourcePort: output.id,
      target: target.id,
      targetPort: 'text',
    });
    render();
    saveState();
    setRunStatus('Text Merge created and connected to this text output.', 'ok');
    return;
  }
  if (action === 'node-create-preview') {
    const output = (nodeDefs[node.type].outputs || []).find(port => ['image', 'video'].includes(port.type));
    if (output) {
      createUndoSnapshot('Create Preview node');
      const target = makeNode('preview', node.x + 350, node.y);
      state.nodes.push(target);
      state.connectingFrom = { nodeId: node.id, portId: output.id };
      connect(target.id, 'media');
    }
    return;
  }
  if (action === 'node-disconnect') {
    if (state.edges.some(edge => edge.source === node.id || edge.target === node.id)) {
      createUndoSnapshot('Disconnect node');
      state.edges = state.edges.filter(edge => edge.source !== node.id && edge.target !== node.id);
      render();
      saveState();
      setRunStatus('Node connections removed.', 'ok');
    }
    return;
  }
  const el = document.querySelector(`.node[data-id="${CSS.escape(node.id)}"]`);
  if (action === 'node-focus-text') {
    el?.querySelector('textarea')?.focus();
    return;
  }
  if (action === 'node-choose-image') {
    el?.querySelector('input[type="file"]')?.click();
    return;
  }
  if (action === 'node-download-image' || action === 'node-download-preview') {
    const url = node.data.asset?.url;
    if (url) {
      const link = document.createElement('a');
      link.href = url;
      const extension = /^data:image\/(\w+)/.exec(url)?.[1]?.replace('jpeg', 'jpg') || 'png';
      link.download = node.data.characterName
        ? `${node.data.characterName}.${extension}`
        : node.data.asset.name || 'museta-output';
      link.click();
    } else setRunStatus('This node has no output to download.', 'warn');
    return;
  }
  if (action === 'node-duplicate') {
    createUndoSnapshot('Duplicate node');
    const copy = structuredClone(node);
    copy.id = uid(node.type);
    copy.x += 36;
    copy.y += 36;
    copy.data = { ...copy.data };
    state.nodes.push(copy);
    if (['generateImage', 'generateVideo'].includes(copy.type)) {
      const references = state.nodes.find(item => item.type === 'references');
      if (references) connectReferenceNode(references, copy);
    }
    render();
    saveState();
    setRunStatus('Node duplicated.', 'ok');
  }
}
export function runCanvasAction(action) {
  if (action === 'edge-delete') {
    const menu = $('#canvasMenu'),
      edgeId = menu.dataset.edgeId;
    closeCanvasMenu();
    if (!edgeId) return;
    const before = state.edges.length;
    if (state.edges.some(edge => edge.id === edgeId)) createUndoSnapshot('Delete connection');
    state.edges = state.edges.filter(edge => edge.id !== edgeId);
    delete menu.dataset.edgeId;
    if (state.edges.length !== before) {
      render();
      saveState();
      setRunStatus('Connection deleted.', 'ok');
    }
    return;
  }
  if (action.startsWith('node-')) {
    runNodeContextAction(action);
    return;
  }
  closeCanvasMenu();
  const pos = state.contextPoint;
  if (action === 'add:text') {
    addTextNote(pos.x, pos.y);
    return;
  }
  if (action.startsWith('add:')) {
    addNode(action.slice(4), pos.x, pos.y);
    return;
  }
  if (action === 'save') {
    saveState();
    return;
  }
  if (action === 'run') {
    executeWorkflow();
    return;
  }
  if (action === 'arrange') {
    arrangeNodes();
    return;
  }
  if (action === 'delete-selected') {
    if (state.selectedNodeIds.length) removeSelectedNodes();
    else if (state.selectedNodeId) removeNode(state.selectedNodeId);
    else setRunStatus('Select one or more nodes first.', 'warn');
    return;
  }
  if (action === 'disconnect-all') {
    if (state.edges.length) {
      createUndoSnapshot('Remove all connections');
      state.edges = [];
      state.connectingFrom = null;
      render();
      saveState();
      setRunStatus('All connections removed.', 'ok');
    }
  }
}
