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
      ['＋ Ghi chú', 'add:text'],
      ['＋ Negative Prompt', 'add:negativePrompt'],
      ['＋ Image Input', 'add:imageInput'],
      ['＋ References', 'add:references'],
      ['＋ Generate Image', 'add:generateImage'],
      ['＋ Generate Video', 'add:generateVideo'],
      ['＋ Timeline', 'add:timeline'],
      ['＋ Voiceover', 'add:voiceover'],
      ['＋ Preview', 'add:preview'],
      ['Lưu workflow', 'save'],
      ['▶ Chạy workflow', 'run'],
      ['Sắp xếp node', 'arrange'],
      ['Xoá node đã chọn', 'delete-selected'],
      ['Xoá mọi kết nối', 'disconnect-all'],
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
  addAction('Đổi tên node…', 'node-rename');
  if (['generateImage', 'generateVideo'].includes(node.type))
    addAction(
      node.data.status === 'running'
        ? `■ Dừng ${node.type === 'generateVideo' ? 'video' : 'ảnh'}`
        : `▶ Chạy ${node.type === 'generateVideo' ? 'video' : 'ảnh'}`,
      'node-run',
    );
  if (node.type === 'generateVideo') addAction('↻ Làm lại · bám sát prompt hơn', 'node-again');
  if (node.type === 'timeline') addAction('▶ Xem trước cả chuỗi', 'node-preview');
  if ((nodeDefs[node.type]?.outputs || []).some(port => port.type === 'text'))
    addAction('Tạo node Text Merge', 'node-create-text-merge');
  if ((nodeDefs[node.type]?.outputs || []).some(port => ['image', 'video'].includes(port.type)))
    addAction('Tạo node Preview', 'node-create-preview');
  if (node.type === 'imageInput') addAction('Chọn / thay ảnh', 'node-choose-image');
  if (node.type === 'imageResize') addAction('Tải xuống ảnh đã đổi cỡ', 'node-download-image');
  if (node.type === 'generateImage' && node.data.asset?.url)
    addAction(node.data.characterName ? 'Lưu ảnh nhân vật' : 'Tải xuống ảnh', 'node-download-image');
  if (node.type === 'preview') addAction('Tải xuống bản xem trước', 'node-download-preview');
  if (node.type === 'prompt' || node.type === 'negativePrompt' || node.type === 'textAppend')
    addAction('Chuyển tới ô văn bản', 'node-focus-text');
  addAction('Nhân bản node', 'node-duplicate');
  addAction('Ngắt kết nối node', 'node-disconnect');
  addAction('Xoá node', 'node-delete');
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
  title.textContent = 'Kết nối';
  menu.appendChild(title);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Xoá kết nối';
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
      name = window.prompt('Nhập tên cho node này:', current);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setRunStatus('Tên node không được để trống.', 'warn');
      return;
    }
    createUndoSnapshot('Đổi tên node');
    node.data.customName = trimmed;
    render();
    saveState();
    setRunStatus('Đã đổi tên node.', 'ok');
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
    createUndoSnapshot('Tạo node Text Merge');
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
    setRunStatus('Đã tạo Text Merge và nối với đầu ra văn bản này.', 'ok');
    return;
  }
  if (action === 'node-create-preview') {
    const output = (nodeDefs[node.type].outputs || []).find(port => ['image', 'video'].includes(port.type));
    if (output) {
      createUndoSnapshot('Tạo node Preview');
      const target = makeNode('preview', node.x + 350, node.y);
      state.nodes.push(target);
      state.connectingFrom = { nodeId: node.id, portId: output.id };
      connect(target.id, 'media');
    }
    return;
  }
  if (action === 'node-disconnect') {
    if (state.edges.some(edge => edge.source === node.id || edge.target === node.id)) {
      createUndoSnapshot('Ngắt kết nối node');
      state.edges = state.edges.filter(edge => edge.source !== node.id && edge.target !== node.id);
      render();
      saveState();
      setRunStatus('Đã xoá các kết nối của node.', 'ok');
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
    } else setRunStatus('Node này chưa có kết quả để tải xuống.', 'warn');
    return;
  }
  if (action === 'node-duplicate') {
    createUndoSnapshot('Nhân bản node');
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
    setRunStatus('Đã nhân bản node.', 'ok');
  }
}
export function runCanvasAction(action) {
  if (action === 'edge-delete') {
    const menu = $('#canvasMenu'),
      edgeId = menu.dataset.edgeId;
    closeCanvasMenu();
    if (!edgeId) return;
    const before = state.edges.length;
    if (state.edges.some(edge => edge.id === edgeId)) createUndoSnapshot('Xoá kết nối');
    state.edges = state.edges.filter(edge => edge.id !== edgeId);
    delete menu.dataset.edgeId;
    if (state.edges.length !== before) {
      render();
      saveState();
      setRunStatus('Đã xoá kết nối.', 'ok');
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
    else setRunStatus('Hãy chọn một hoặc nhiều node trước.', 'warn');
    return;
  }
  if (action === 'disconnect-all') {
    if (state.edges.length) {
      createUndoSnapshot('Xoá mọi kết nối');
      state.edges = [];
      state.connectingFrom = null;
      render();
      saveState();
      setRunStatus('Đã xoá mọi kết nối.', 'ok');
    }
  }
}
