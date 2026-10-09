import { state } from '../core/state.js';
import { normalizeSavedGraph } from '../core/graph.js';
import { setRunStatus } from './dom.js';
import { syncSettingsUI } from './persistence.js';
import { render } from './render.js';

const undoStack = [];
const maxUndoSteps = 40;
let lastUndoInput = null;
let pendingNativeUndoTarget = null;
const undoTrackedSelector = '.node,.canvas-note,.timeline-dock,#settingsModal';

export function createUndoSnapshot(label, { preserveRuntime = true } = {}) {
  const nodes = state.nodes.map(node => {
    const data = { ...(node.data || {}) };
    if (data.asset && typeof data.asset === 'object') data.asset = { ...data.asset };
    if (data.endFrame && typeof data.endFrame === 'object') data.endFrame = { ...data.endFrame };
    if (Array.isArray(data.clipOrder)) data.clipOrder = [...data.clipOrder];
    if (data.durations && typeof data.durations === 'object') data.durations = { ...data.durations };
    return { ...node, data };
  });
  undoStack.push({
    label,
    preserveRuntime,
    nodes,
    edges: state.edges.map(edge => ({ ...edge })),
    groups: structuredClone(state.groups || []),
    notes: structuredClone(state.notes || []),
    settings: structuredClone(state.settings || {}),
  });
  if (undoStack.length > maxUndoSteps) undoStack.shift();
}

export function undoLastChange() {
  if (state.isRunning) {
    setRunStatus('Stop the running workflow before undoing edits.', 'warn');
    return;
  }
  const previous = undoStack.pop();
  if (!previous) {
    setRunStatus('Nothing to undo.', 'warn');
    return;
  }
  if (previous.preserveRuntime) {
    const runtimeById = new Map(
      state.nodes.map(node => [node.id, { type: node.type, data: node.data || {} }]),
    );
    for (const node of previous.nodes) {
      const current = runtimeById.get(node.id);
      if (!current || current.type !== node.type) continue;
      const runtime = current.data;
      for (const key of ['status', 'error', 'asset', 'endFrame']) {
        if (Object.hasOwn(runtime, key)) node.data[key] = runtime[key];
        else delete node.data[key];
      }
    }
  }
  state.nodes = previous.nodes;
  state.edges = previous.edges;
  state.groups = previous.groups || [];
  state.notes = previous.notes || [];
  state.settings = previous.settings;
  state.selectedNodeIds = [];
  state.selectedNodeId = null;
  state.selectedEdgeIds = [];
  state.connectingFrom = null;
  normalizeSavedGraph();
  syncSettingsUI();
  render();
  setRunStatus(`Undid: ${previous.label}.`, 'ok');
}

export function isUndoTrackedTarget(target) {
  return Boolean(target?.closest?.(undoTrackedSelector));
}

export function trackUndoEdit(event) {
  const target = event.target;
  if (!isUndoTrackedTarget(target)) return;
  const owner = target.closest('.node'),
    title = owner?.querySelector('.node-title')?.textContent || 'text note';
  if (pendingNativeUndoTarget === target) {
    if (lastUndoInput === target && undoStack.at(-1)?.label === `Edit ${title}`) undoStack.pop();
    lastUndoInput = null;
    pendingNativeUndoTarget = null;
    return;
  }
  if (lastUndoInput !== target) {
    createUndoSnapshot(`Edit ${title}`);
    lastUndoInput = target;
  }
}

export function forgetUndoInput(target) {
  if (target === lastUndoInput) lastUndoInput = null;
}

export function deferToNativeUndo(target) {
  pendingNativeUndoTarget = target;
  setTimeout(() => {
    if (pendingNativeUndoTarget === target) pendingNativeUndoTarget = null;
  }, 0);
}

export function releaseNativeUndo(target) {
  if (pendingNativeUndoTarget === target) pendingNativeUndoTarget = null;
}
