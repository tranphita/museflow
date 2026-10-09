import { state } from '../core/state.js';
import { uid } from '../core/node-defs.js';
import { $, canvas, edgesSvg, setRunStatus } from './dom.js';
import { saveState } from './persistence.js';
import { createUndoSnapshot } from './undo.js';
import { scheduleDrawEdges, render } from './render.js';

export function applyCanvasTransform() {
  const transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  canvas.style.transform = transform;
  edgesSvg.style.transform = transform;
  $('#zoomLevel').textContent = `${Math.round(state.zoom * 100)}%`;
  $('#viewport').classList.toggle('hand-mode', state.handMode || state.spaceDown);
}
export function zoomAt(clientX, clientY, factor) {
  const rect = $('#viewport').getBoundingClientRect(),
    x = clientX - rect.left,
    y = clientY - rect.top,
    old = state.zoom,
    next = Math.max(0.25, Math.min(2.5, old * factor));
  if (next === old) return;
  const contentX = (x - state.panX) / old,
    contentY = (y - state.panY) / old;
  state.zoom = next;
  state.panX = x - contentX * next;
  state.panY = y - contentY * next;
  applyCanvasTransform();
  scheduleDrawEdges();
}
export function setZoom(value) {
  const rect = $('#viewport').getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, value / state.zoom);
}
export function fitCanvas() {
  const nodes = state.nodes.filter(node => !node.data?.dockOnly);
  if (!nodes.length) {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    applyCanvasTransform();
    return;
  }
  const rect = $('#viewport').getBoundingClientRect(),
    xs = nodes.map(n => n.x),
    ys = nodes.map(n => n.y),
    maxX = Math.max(
      ...nodes.map(
        n => n.x + (document.querySelector(`.node[data-id="${CSS.escape(n.id)}"]`)?.offsetWidth || 270),
      ),
    ),
    maxY = Math.max(
      ...nodes.map(
        n => n.y + (document.querySelector(`.node[data-id="${CSS.escape(n.id)}"]`)?.offsetHeight || 220),
      ),
    );
  const minX = Math.min(...xs),
    minY = Math.min(...ys),
    scale = Math.max(
      0.25,
      Math.min(1.5, (rect.width - 100) / (maxX - minX + 80), (rect.height - 80) / (maxY - minY + 80)),
    );
  state.zoom = scale;
  state.panX = (rect.width - (maxX - minX) * scale) / 2 - minX * scale;
  state.panY = (rect.height - (maxY - minY) * scale) / 2 - minY * scale;
  applyCanvasTransform();
  scheduleDrawEdges();
}
export function startPan(event) {
  state.panning = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
  $('#viewport').classList.add('panning');
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {}
  event.preventDefault();
}
export function movePan(event) {
  if (!state.panning) return;
  state.panX = state.panning.panX + event.clientX - state.panning.x;
  state.panY = state.panning.panY + event.clientY - state.panning.y;
  applyCanvasTransform();
  scheduleDrawEdges();
}
export function endPan() {
  state.panning = null;
  $('#viewport').classList.remove('panning');
}

export function startSelectionMarquee(event) {
  if (
    event.button !== 0 ||
    state.handMode ||
    state.spaceDown ||
    event.target.closest('.node,.canvas-note,.canvas-tools,button')
  )
    return;
  const viewport = $('#viewport'),
    bounds = viewport.getBoundingClientRect(),
    keep = event.shiftKey || event.ctrlKey || event.metaKey;
  if (state.groupDrawMode) {
    const box = document.createElement('div');
    box.className = 'group-marquee';
    viewport.appendChild(box);
    state.groupMarquee = { startX: event.clientX, startY: event.clientY, bounds, box };
    try {
      viewport.setPointerCapture(event.pointerId);
    } catch {}
    event.preventDefault();
    return;
  }
  if (!keep) {
    state.selectedNodeIds = [];
    state.selectedNodeId = null;
    state.selectedEdgeIds = [];
    document.querySelectorAll('.node.selected').forEach(node => node.classList.remove('selected'));
    scheduleDrawEdges();
  }
  const box = document.createElement('div');
  box.className = 'selection-marquee';
  viewport.appendChild(box);
  state.selectionMarquee = {
    startX: event.clientX,
    startY: event.clientY,
    bounds,
    box,
    keep,
    initial: [...state.selectedNodeIds],
    initialEdges: keep ? [...state.selectedEdgeIds] : [],
  };
  try {
    viewport.setPointerCapture(event.pointerId);
  } catch {}
  event.preventDefault();
}
export function moveSelectionMarquee(event) {
  const drag = state.selectionMarquee;
  if (!drag) return;
  const left = Math.min(event.clientX, drag.startX),
    top = Math.min(event.clientY, drag.startY),
    right = Math.max(event.clientX, drag.startX),
    bottom = Math.max(event.clientY, drag.startY);
  Object.assign(drag.box.style, {
    left: `${left - drag.bounds.left}px`,
    top: `${top - drag.bounds.top}px`,
    width: `${right - left}px`,
    height: `${bottom - top}px`,
  });
  const selected = new Set(drag.initial);
  for (const node of document.querySelectorAll('.node')) {
    const r = node.getBoundingClientRect();
    if (r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom)
      selected.add(node.dataset.id);
  }
  state.selectedNodeIds = [...selected];
  state.selectedNodeId = state.selectedNodeIds.at(-1) || null;
  document
    .querySelectorAll('.node')
    .forEach(node => node.classList.toggle('selected', selected.has(node.dataset.id)));
  const selectedEdges = new Set(drag.initialEdges);
  for (const path of edgesSvg.querySelectorAll('.edge[data-edge-id]')) {
    const matrix = path.getScreenCTM();
    if (!matrix) continue;
    const length = path.getTotalLength();
    for (let point = 0; point <= length; point += Math.max(8, length / 60)) {
      const p = new DOMPoint(path.getPointAtLength(point).x, path.getPointAtLength(point).y).matrixTransform(
        matrix,
      );
      if (p.x >= left && p.x <= right && p.y >= top && p.y <= bottom) {
        selectedEdges.add(path.dataset.edgeId);
        break;
      }
    }
  }
  state.selectedEdgeIds = [...selectedEdges];
  scheduleDrawEdges();
}
export function endSelectionMarquee() {
  const drag = state.selectionMarquee;
  if (!drag) return;
  drag.box.remove();
  state.selectionMarquee = null;
}

export function moveGroupMarquee(event) {
  const drag = state.groupMarquee;
  if (!drag) return;
  const left = Math.min(event.clientX, drag.startX),
    top = Math.min(event.clientY, drag.startY),
    right = Math.max(event.clientX, drag.startX),
    bottom = Math.max(event.clientY, drag.startY);
  Object.assign(drag.box.style, {
    left: `${left - drag.bounds.left}px`,
    top: `${top - drag.bounds.top}px`,
    width: `${right - left}px`,
    height: `${bottom - top}px`,
  });
}
export function finishGroupMarquee(event) {
  const drag = state.groupMarquee;
  if (!drag) return;
  const left = Math.min(event.clientX, drag.startX),
    top = Math.min(event.clientY, drag.startY),
    right = Math.max(event.clientX, drag.startX),
    bottom = Math.max(event.clientY, drag.startY);
  drag.box.remove();
  state.groupMarquee = null;
  const width = right - left,
    height = bottom - top;
  if (width < 60 || height < 45) {
    setGroupDrawMode(false);
    setRunStatus('Group region is too small. Drag a larger area to create it.', 'warn');
    return;
  }
  const zoom = state.zoom,
    viewport = drag.bounds,
    x = (left - viewport.left - state.panX) / zoom,
    y = (top - viewport.top - state.panY) / zoom,
    w = width / zoom,
    h = height / zoom,
    nodeIds = [...document.querySelectorAll('.node')]
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.left >= left && rect.right <= right && rect.top >= top && rect.bottom <= bottom;
      })
      .map(element => element.dataset.id);
  createUndoSnapshot('Create group region');
  state.groups.push({
    id: uid('group'),
    name: `Group ${state.groups.length + 1}`,
    x,
    y,
    width: w,
    height: h,
    nodeIds,
  });
  setGroupDrawMode(false);
  render();
  saveState();
  setRunStatus(
    `Group region created${nodeIds.length ? ` around ${nodeIds.length} node${nodeIds.length === 1 ? '' : 's'}` : ''}.`,
    'ok',
  );
}
export function cancelGroupMarquee() {
  const drag = state.groupMarquee;
  if (drag) {
    drag.box.remove();
    state.groupMarquee = null;
  }
  setGroupDrawMode(false);
}
export function setGroupDrawMode(active) {
  state.groupDrawMode = Boolean(active);
  $('#groupTool')?.classList.toggle('active', state.groupDrawMode);
  $('#groupTool')?.setAttribute('aria-pressed', String(state.groupDrawMode));
  $('#viewport').classList.toggle('group-draw-mode', state.groupDrawMode);
  if (state.groupDrawMode)
    setRunStatus(
      'Group tool active: drag across the canvas to mark a group region. Press G or Escape to cancel.',
      'warn',
    );
}
