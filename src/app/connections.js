import { state } from '../core/state.js';
import { nodeDefs, uid, isMultiInput } from '../core/node-defs.js';
import { nodeById, getIncoming, wouldCreateCycle, portCompatible } from '../core/graph.js';
import { $, setRunStatus } from './dom.js';
import { createUndoSnapshot } from './undo.js';
import { addNode, selectNode } from './editor.js';
import { scheduleDrawEdges, render } from './render.js';
import { closeCanvasMenu } from './menus.js';
import { ensureDockTimeline, addTimelineClip, toggleTimeline } from './timeline.js';

export function connectionChoices(from) {
  const source = nodeById(from.nodeId),
    output = nodeDefs[source?.type]?.outputs?.find(port => port.id === from.portId);
  if (!source || !output) return { existing: [], create: [] };
  const existing = [];
  for (const target of state.nodes) {
    if (target.id === source.id) continue;
    for (const input of nodeDefs[target.type]?.inputs || []) {
      if (!portCompatible(from, target.id, input.id)) continue;
      if (target.type === 'timeline' && getIncoming(target.id, input.id).length) continue;
      if (wouldCreateCycle(source.id, target.id, isMultiInput(target.type, input.id) ? null : input.id))
        continue;
      existing.push({
        kind: 'existing',
        targetId: target.id,
        targetPort: input.id,
        label: `${nodeDefs[target.type].title} · ${input.label}${target.data?.dockOnly ? ' (Timeline dock)' : ''}`,
      });
    }
  }
  const candidates =
    output.type === 'image'
      ? [
          ['references', 'reference1', 'References · image 1'],
          ['preview', 'media', 'Preview · image'],
          ['imageResize', 'image', 'Image Resize'],
          ['generateImage', 'reference', 'Generate Image · reference'],
          ['generateVideo', 'reference', 'Generate Video · reference'],
        ]
      : output.type === 'video'
        ? [
            ['preview', 'media', 'Preview · video'],
            ['timeline', 'clip1', 'Timeline · add clip'],
          ]
        : output.type === 'text'
          ? [
              ['generateImage', 'prompt', 'Generate Image · prompt'],
              ['generateVideo', 'prompt', 'Generate Video · prompt'],
              ['textAppend', 'text', 'Text Append'],
              ['textConcat', 'text', 'Text Merge · text'],
              ['voiceover', 'text', 'Voiceover · text'],
            ]
          : output.type === 'negative'
            ? [
                ['generateImage', 'negative', 'Generate Image · negative'],
                ['generateVideo', 'negative', 'Generate Video · negative'],
              ]
            : output.type === 'audio'
              ? [['generateVideo', 'voice', 'Generate Video · voice']]
              : [];
  const create = candidates.map(([type, port, label]) => ({
    kind: 'create',
    type,
    targetPort: port,
    label,
  }));
  return { existing, create };
}

export function openConnectionPicker(from, x, y) {
  const output = nodeDefs[nodeById(from.nodeId)?.type]?.outputs?.find(port => port.id === from.portId),
    choices = connectionChoices(from),
    menu = $('#canvasMenu'),
    viewport = $('#viewport').getBoundingClientRect();
  if (!output) return;
  state.pendingConnection = {
    from: { ...from },
    x: (x - viewport.left - state.panX) / state.zoom,
    y: (y - viewport.top - state.panY) / state.zoom,
    choices: [...choices.existing, ...choices.create],
  };
  menu.innerHTML = '';
  delete menu.dataset.nodeId;
  delete menu.dataset.edgeId;
  const title = document.createElement('div');
  title.className = 'menu-caption';
  title.textContent = `Send ${output.label} · ${output.type}`;
  menu.appendChild(title);
  const addSection = label => {
    const section = document.createElement('div');
    section.className = 'menu-caption';
    section.textContent = label;
    menu.appendChild(section);
  };
  const addChoice = (choice, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = choice.label;
    button.dataset.contextAction = 'connect-choice';
    button.dataset.choice = String(index);
    menu.appendChild(button);
  };
  if (choices.existing.length) {
    addSection('Connect existing node');
    choices.existing.forEach((choice, index) => addChoice(choice, index));
  }
  if (choices.create.length) {
    addSection('Create a compatible node');
    choices.create.forEach((choice, index) => addChoice(choice, choices.existing.length + index));
  }
  if (!state.pendingConnection.choices.length) {
    const empty = document.createElement('div');
    empty.className = 'menu-caption';
    empty.textContent = 'No compatible node actions for this output.';
    menu.appendChild(empty);
  }
  menu.classList.remove('hidden');
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - 260))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - 420))}px`;
}

export function runConnectionChoice(index) {
  const pending = state.pendingConnection,
    choice = pending?.choices?.[index];
  state.pendingConnection = null;
  closeCanvasMenu();
  if (!pending || !choice) return;
  if (choice.kind === 'existing') {
    state.connectingFrom = pending.from;
    connect(choice.targetId, choice.targetPort);
    selectNode(choice.targetId, { add: true });
    setRunStatus(`Connected to ${choice.label}.`, 'ok');
    return;
  }
  const before = new Set(state.nodes.map(node => node.id));
  addNode(choice.type, pending.x - 135, pending.y - 80);
  const target =
    state.nodes.find(node => !before.has(node.id)) ||
    state.nodes.find(
      node => node.type === choice.type && node.data?.dockOnly === false && choice.type === 'timeline',
    );
  if (!target || target.type !== choice.type) {
    setRunStatus('Could not create the selected node.', 'error');
    return;
  }
  state.connectingFrom = pending.from;
  connect(target.id, choice.targetPort);
  selectNode(target.id);
  setRunStatus(
    `${nodeDefs[target.type].title} created and connected to ${choice.label.split(' · ').at(-1)}.`,
    'ok',
  );
}

export function connect(targetNodeId, targetPortId) {
  const from = state.connectingFrom;
  if (!from) return;
  if (!portCompatible(from, targetNodeId, targetPortId)) {
    setRunStatus('Port types are not compatible.', 'error');
    state.connectingFrom = null;
    return;
  }
  const target = nodeById(targetNodeId),
    source = nodeById(from.nodeId),
    multi = isMultiInput(target?.type, targetPortId);
  if (wouldCreateCycle(from.nodeId, targetNodeId, multi ? null : targetPortId)) {
    setRunStatus(
      'This connection would create a workflow loop. Connect the nodes in one direction.',
      'error',
    );
    state.connectingFrom = null;
    return;
  }
  const duplicate = state.edges.some(
    edge =>
      edge.source === from.nodeId &&
      edge.sourcePort === from.portId &&
      edge.target === targetNodeId &&
      edge.targetPort === targetPortId,
  );
  const willReplace =
    !multi &&
    state.edges.some(
      edge =>
        edge.target === targetNodeId &&
        edge.targetPort === targetPortId &&
        !(edge.source === from.nodeId && edge.sourcePort === from.portId),
    );
  if (!duplicate || willReplace) createUndoSnapshot('Connect nodes');
  if (!multi)
    state.edges = state.edges.filter(
      edge => !(edge.target === targetNodeId && edge.targetPort === targetPortId),
    );
  if (!duplicate)
    state.edges.push({
      id: uid('edge'),
      source: from.nodeId,
      sourcePort: from.portId,
      target: targetNodeId,
      targetPort: targetPortId,
    });
  if (target?.type === 'timeline' && targetPortId.startsWith('clip') && source?.type === 'generateVideo') {
    target.data.clipOrder = target.data.clipOrder || [];
    if (!target.data.clipOrder.includes(source.id)) target.data.clipOrder.push(source.id);
  }
  state.connectingFrom = null;
  render();
}

export function nearestCompatibleInput(x, y, from) {
  let best = null,
    bestDistance = 44;
  for (const port of document.querySelectorAll('.port.in')) {
    if (!portCompatible(from, port.dataset.node, port.dataset.port)) continue;
    const rect = port.getBoundingClientRect(),
      distance = Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2));
    if (distance < bestDistance) {
      best = port;
      bestDistance = distance;
    }
  }
  return best;
}
export function screenToCanvas(x, y) {
  const rect = $('#viewport').getBoundingClientRect();
  return { x: x - rect.left, y: y - rect.top };
}

export function startWire(e, nodeId, portId) {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  state.draggingWire = { nodeId, portId };
  state.connectingFrom = { nodeId, portId };
  state.wireMoved = false;
  const sourceForCapture = nodeById(nodeId);
  if (!(sourceForCapture?.type === 'generateVideo' && portId === 'video'))
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
  state.wirePointer = { x: e.clientX, y: e.clientY };
  state.wireOrigin = { x: e.clientX, y: e.clientY };
  document.querySelectorAll('.port.in').forEach(port => {
    if (portCompatible({ nodeId, portId }, port.dataset.node, port.dataset.port))
      port.classList.add('wire-compatible');
  });
}

export function startWireFromInput(e, nodeId, portId, portType) {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  state.draggingWire = { nodeId, portId, direction: 'in', portType };
  state.wireMoved = false;
  state.wirePointer = { x: e.clientX, y: e.clientY };
  state.wireOrigin = { x: e.clientX, y: e.clientY };
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {}
  document.querySelectorAll('.port.out').forEach(port => {
    if (portCompatible({ nodeId: port.dataset.node, portId: port.dataset.port }, nodeId, portId))
      port.classList.add('wire-compatible');
  });
}

export function onWireMove(e) {
  if (!state.draggingWire) return;
  if (state.wireOrigin && Math.hypot(e.clientX - state.wireOrigin.x, e.clientY - state.wireOrigin.y) > 5)
    state.wireMoved = true;
  const source = nodeById(state.draggingWire.nodeId),
    dock = $('#timelineDock'),
    overDock =
      source?.type === 'generateVideo' &&
      state.draggingWire.portId === 'video' &&
      (() => {
        const r = dock.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      })();
  dock.classList.toggle('wire-drop-target', Boolean(overDock));
  if (overDock && dock.classList.contains('collapsed')) toggleTimeline();
  state.wirePointer = { x: e.clientX, y: e.clientY };
  scheduleDrawEdges();
}

export function onWireUp(e) {
  if (!state.draggingWire) return;
  const from = state.draggingWire,
    moved = state.wireMoved,
    source = nodeById(from.nodeId),
    dock = $('#timelineDock'),
    r = dock.getBoundingClientRect(),
    droppedOnTimeline =
      source?.type === 'generateVideo' &&
      from.portId === 'video' &&
      e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom;
  state.draggingWire = null;
  state.wirePointer = null;
  state.wireOrigin = null;
  dock.classList.remove('wire-drop-target');
  document.querySelectorAll('.wire-compatible').forEach(port => port.classList.remove('wire-compatible'));
  if (moved && from.direction === 'in') {
    const output = nearestCompatibleOutput(e.clientX, e.clientY, from);
    if (output) {
      state.connectingFrom = { nodeId: output.dataset.node, portId: output.dataset.port };
      connect(from.nodeId, from.portId);
    } else {
      const rect = $('#viewport').getBoundingClientRect(),
        emptyCanvas = !document.elementFromPoint(e.clientX, e.clientY)?.closest('.node'),
        inside =
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom,
        type = from.portType === 'negative' ? 'negativePrompt' : 'prompt';
      if (inside && emptyCanvas) {
        addNode(
          type,
          (e.clientX - rect.left - state.panX) / state.zoom - 135,
          (e.clientY - rect.top - state.panY) / state.zoom - 80,
        );
        const created = state.nodes.at(-1);
        state.connectingFrom = { nodeId: created.id, portId: 'text' };
        connect(from.nodeId, from.portId);
        setRunStatus(`${nodeDefs[type].title} created and connected.`, 'ok');
      } else setRunStatus('Drop on an output port or on empty canvas to create a prompt node.', 'warn');
    }
    state.suppressPortClick = true;
    setTimeout(() => (state.suppressPortClick = false), 80);
    scheduleDrawEdges();
    return;
  }
  if (moved) {
    if (droppedOnTimeline) {
      addTimelineClip(ensureDockTimeline(), source.id);
      state.connectingFrom = null;
      state.suppressPortClick = true;
      setTimeout(() => (state.suppressPortClick = false), 80);
      scheduleDrawEdges();
      return;
    }
    const hit = nearestCompatibleInput(e.clientX, e.clientY, from);
    if (hit) {
      state.connectingFrom = from;
      connect(hit.dataset.node, hit.dataset.port);
    } else {
      const rect = $('#viewport').getBoundingClientRect(),
        inside =
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom;
      if (inside) openConnectionPicker(from, e.clientX, e.clientY);
      else {
        state.connectingFrom = null;
        setRunStatus('Drop the output on the canvas to choose a compatible node.', 'warn');
      }
    }
    state.suppressPortClick = true;
    setTimeout(() => (state.suppressPortClick = false), 80);
  }
  scheduleDrawEdges();
}

export function nearestInputPort(x, y) {
  const direct = document
    .elementsFromPoint(x, y)
    .map(el => el.closest?.('.port.in'))
    .filter(Boolean);
  const candidates = [...new Set([...direct, ...document.querySelectorAll('.port.in.wire-compatible')])];
  let best = null,
    distance = Infinity;
  for (const port of candidates) {
    if (!port.classList.contains('wire-compatible')) continue;
    const r = port.getBoundingClientRect(),
      d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
    if (d < distance) {
      best = port;
      distance = d;
    }
  }
  return best && distance <= 38 ? best : null;
}
export function nearestCompatibleOutput(x, y, target) {
  let best = null,
    distance = 44;
  for (const port of document.querySelectorAll('.port.out')) {
    if (
      !portCompatible({ nodeId: port.dataset.node, portId: port.dataset.port }, target.nodeId, target.portId)
    )
      continue;
    const rect = port.getBoundingClientRect(),
      d = Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2));
    if (d < distance) {
      best = port;
      distance = d;
    }
  }
  return best;
}
