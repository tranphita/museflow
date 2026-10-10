import { state } from './state.js';
import { nodeDefs, uid, canConnectTypes, isMultiInput } from './node-defs.js';

export function duplicateNodesForDrag(ids) {
  const selected = new Set(ids),
    copies = new Map(),
    newNodes = [];
  for (const id of ids) {
    const original = nodeById(id);
    if (!original) continue;
    const copy = { ...original, id: uid(original.type), data: { ...(original.data || {}) } };
    copies.set(id, copy.id);
    newNodes.push(copy);
  }
  if (!newNodes.length) return [];
  const newEdges = state.edges
    .filter(edge => selected.has(edge.target))
    .map(edge => ({
      ...edge,
      id: uid('edge'),
      source: copies.get(edge.source) || edge.source,
      target: copies.get(edge.target),
    }));
  state.nodes.push(...newNodes);
  state.edges.push(...newEdges);
  const newIds = newNodes.map(node => node.id);
  state.selectedNodeIds = newIds;
  state.selectedNodeId = newIds.at(-1) || null;
  return newIds;
}

export function nodeById(id) {
  return state.nodes.find(n => n.id === id);
}

export function portCompatible(from, targetNodeId, targetPortId) {
  const sourceNode = nodeById(from.nodeId),
    targetNode = nodeById(targetNodeId);
  if (!sourceNode || !targetNode || sourceNode.id === targetNode.id) return false;
  const out = (nodeDefs[sourceNode.type].outputs || []).find(p => p.id === from.portId);
  const input = (nodeDefs[targetNode.type].inputs || []).find(p => p.id === targetPortId);
  return Boolean(out && input && canConnectTypes(out.type, input.type));
}

export function wouldCreateCycle(sourceId, targetId, replacedPort) {
  const pending = [targetId],
    seen = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (id === sourceId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of state.edges) {
      if (edge.source === id && !(edge.target === targetId && edge.targetPort === replacedPort))
        pending.push(edge.target);
    }
  }
  return false;
}

export function connectReferenceNode(references, generator) {
  if (!references || !generator || !['generateImage', 'generateVideo'].includes(generator.type)) return;
  const duplicate = state.edges.some(
    edge =>
      edge.source === references.id &&
      edge.sourcePort === 'image' &&
      edge.target === generator.id &&
      edge.targetPort === 'reference',
  );
  if (!duplicate)
    state.edges.push({
      id: uid('edge'),
      source: references.id,
      sourcePort: 'image',
      target: generator.id,
      targetPort: 'reference',
    });
}
export function syncReferenceFanOut(references) {
  for (const generator of state.nodes.filter(node => ['generateImage', 'generateVideo'].includes(node.type)))
    connectReferenceNode(references, generator);
}

export function normalizeSavedGraph() {
  const knownNodes = new Set(Object.keys(nodeDefs));
  state.notes = Array.isArray(state.notes) ? state.notes : [];
  for (const legacy of state.nodes.filter(node => node?.type === 'text'))
    if (!state.notes.some(note => note.id === `note-${legacy.id}`))
      state.notes.push({
        id: `note-${legacy.id}`,
        x: Number(legacy.x) || 0,
        y: Number(legacy.y) || 0,
        text: String(legacy.data?.text || ''),
        width: 260,
        height: 160,
      });
  state.nodes = state.nodes.filter(node => node?.type !== 'text');
  const seenNodeIds = new Set();
  state.nodes = state.nodes.filter(node => {
    if (!node || !knownNodes.has(node.type) || typeof node.id !== 'string' || seenNodeIds.has(node.id))
      return false;
    seenNodeIds.add(node.id);
    return true;
  });
  for (const node of state.nodes)
    if (!node.data || typeof node.data !== 'object' || Array.isArray(node.data)) node.data = {};
  for (const node of state.nodes)
    if (node.type === 'timeline') {
      node.data.clipOrder = Array.isArray(node.data.clipOrder)
        ? [
            ...new Set(
              node.data.clipOrder.filter(id =>
                state.nodes.some(item => item.id === id && item.type === 'generateVideo'),
              ),
            ),
          ]
        : [];
      if (
        !node.data.durations ||
        typeof node.data.durations !== 'object' ||
        Array.isArray(node.data.durations)
      )
        node.data.durations = {};
    }
  const normalized = [];
  for (const raw of state.edges) {
    if (!raw || typeof raw.source !== 'string' || typeof raw.target !== 'string') continue;
    const source = nodeById(raw.source),
      target = nodeById(raw.target);
    if (!source || !target || source.id === target.id) continue;
    const outputs = nodeDefs[source.type].outputs || [],
      inputs = nodeDefs[target.type].inputs || [];
    // Only infer port names for old single-port edges; never guess between semantic ports.
    const sourcePort = raw.sourcePort || (outputs.length === 1 ? outputs[0].id : null);
    const sourceDef = outputs.find(port => port.id === sourcePort);
    const compatibleInputs = inputs.filter(port => sourceDef && canConnectTypes(sourceDef.type, port.type));
    const legacyMergePort = target.type === 'textConcat' && ['a', 'b'].includes(raw.targetPort);
    const targetPort = legacyMergePort
      ? 'text'
      : raw.targetPort || (compatibleInputs.length === 1 ? compatibleInputs[0].id : null);
    const inputDef = inputs.find(port => port.id === targetPort);
    if (!sourceDef || !inputDef || !canConnectTypes(sourceDef.type, inputDef.type)) continue;
    normalized.push({ ...raw, id: raw.id || uid('edge'), sourcePort, targetPort });
  }
  // Normal inputs are single-source; prompt and reference inputs retain distinct sources.
  const occupied = new Set(),
    unique = [];
  for (let index = normalized.length - 1; index >= 0; index--) {
    const edge = normalized[index],
      key = isMultiInput(nodeById(edge.target)?.type, edge.targetPort)
        ? `${edge.target}:${edge.targetPort}:${edge.source}:${edge.sourcePort}`
        : `${edge.target}:${edge.targetPort}`;
    if (occupied.has(key)) continue;
    occupied.add(key);
    unique.push(edge);
  }
  state.edges = unique.reverse();
  state.groups = Array.isArray(state.groups)
    ? state.groups
        .filter(
          group =>
            group &&
            Number.isFinite(group.x) &&
            Number.isFinite(group.y) &&
            Number.isFinite(group.width) &&
            Number.isFinite(group.height) &&
            group.width > 0 &&
            group.height > 0,
        )
        .map(group => ({
          ...group,
          id: typeof group.id === 'string' ? group.id : uid('group'),
          name: String(group.name || 'Group'),
          nodeIds: Array.isArray(group.nodeIds) ? group.nodeIds.filter(id => seenNodeIds.has(id)) : [],
        }))
    : [];
}
export function getIncoming(nodeId, targetPort) {
  return state.edges.filter(e => e.target === nodeId && (!targetPort || e.targetPort === targetPort));
}
export function sourceFor(edge) {
  return edge ? nodeById(edge.source) : null;
}

export function resolveText(nodeId, seen = new Set()) {
  if (seen.has(nodeId)) return '';
  seen.add(nodeId);
  const node = nodeById(nodeId);
  if (!node) return '';
  if (['prompt', 'negativePrompt'].includes(node.type))
    return String(node.data?.text ?? node.data?.prompt ?? node.data?.value ?? '');
  if (node.type === 'textAppend') {
    const parent = sourceFor(getIncoming(nodeId, 'text')[0]);
    return [parent ? resolveText(parent.id, new Set(seen)) : '', String(node.data?.text ?? '')]
      .filter(value => value.trim())
      .join(' ');
  }
  if (node.type === 'textConcat') {
    const inputs = getIncoming(nodeId, 'text')
      .map(sourceFor)
      .filter(Boolean)
      .map(source => resolveText(source.id, new Set(seen)))
      .filter(Boolean);
    return inputs.join(node.data.separator ?? ', ');
  }
  const source = sourceFor(getIncoming(nodeId, 'text')[0]);
  return source ? resolveText(source.id, seen) : '';
}
export function resolvePrompt(nodeId) {
  return getIncoming(nodeId, 'prompt')
    .map(edge => nodeById(edge.source))
    .filter(Boolean)
    .map(source => resolveText(source.id).trim())
    .filter(Boolean)
    .join('\n\n');
}
export function resolveNegativePrompt(nodeId) {
  const source = sourceFor(getIncoming(nodeId, 'negative')[0]);
  return source ? resolveText(source.id) : '';
}
export function timelinePredecessor(nodeId) {
  const timeline = state.nodes.find(item => item.type === 'timeline'),
    order = timeline?.data?.clipOrder || [],
    index = order.indexOf(nodeId);
  return index > 0 ? nodeById(order[index - 1]) : null;
}
export function resolveReferences(nodeId) {
  const references = [],
    seen = new Set();
  const add = (url, name, character = '', role = character ? 'character' : 'guide') => {
    if (url && !seen.has(url)) {
      seen.add(url);
      references.push({ url, name: name || `Reference ${references.length + 1}`, character, role });
    }
  };
  const visit = (source, sourcePort, visited = new Set()) => {
    if (!source || visited.has(source.id)) return;
    visited.add(source.id);
    if (source.type === 'references') {
      for (const edge of getIncoming(source.id)) visit(nodeById(edge.source), edge.sourcePort, visited);
      return;
    }
    if (sourcePort === 'endFrame') {
      add(source.data?.endFrame?.url, source.data?.endFrame?.name);
      return;
    }
    if (source.type === 'imageInput' && source.data?.localDataUrl) {
      add(source.data.localDataUrl, 'Input image', source.data.characterName || '');
      return;
    }
    if (source.data?.asset?.kind === 'image')
      add(source.data.asset.url, source.data.asset.name, source.data.characterName || '');
  };
  const node = nodeById(nodeId),
    previous = node?.type === 'generateVideo' && node.data?.continuity ? timelinePredecessor(nodeId) : null;
  if (previous)
    add(
      previous.data?.endFrame?.url,
      `CONTINUITY START FRAME · ${previous.data?.endFrame?.name || 'previous clip end'}`,
      '',
      'continuity',
    );
  for (const edge of getIncoming(nodeId, 'reference')) visit(nodeById(edge.source), edge.sourcePort);
  const rank = { continuity: 0, character: 1, guide: 2 };
  return references
    .map((reference, index) => ({ reference, index }))
    .sort((a, b) => rank[a.reference.role] - rank[b.reference.role] || a.index - b.index)
    .map(({ reference }) => reference);
}

export function topoOrder() {
  const indeg = new Map(state.nodes.map(n => [n.id, 0])),
    outgoing = new Map(state.nodes.map(n => [n.id, []]));
  state.edges.forEach(e => {
    if (!indeg.has(e.source) || !indeg.has(e.target)) return;
    indeg.set(e.target, indeg.get(e.target) + 1);
    outgoing.get(e.source).push(e.target);
  });
  for (const node of state.nodes.filter(item => item.type === 'generateVideo' && item.data?.continuity)) {
    const previous = timelinePredecessor(node.id);
    if (previous && previous.id !== node.id && !outgoing.get(previous.id).includes(node.id)) {
      outgoing.get(previous.id).push(node.id);
      indeg.set(node.id, indeg.get(node.id) + 1);
    }
  }
  const timeline = state.nodes.find(item => item.type === 'timeline'),
    orderedVideos = (timeline?.data?.clipOrder || []).filter(id => nodeById(id)?.type === 'generateVideo');
  for (const node of state.nodes)
    if (node.type === 'generateVideo' && !orderedVideos.includes(node.id)) orderedVideos.push(node.id);
  const videoRank = new Map(orderedVideos.map((id, index) => [id, index])),
    nodeRank = new Map(state.nodes.map((node, index) => [node.id, index]));
  const priority = id => {
    const item = nodeById(id);
    return item?.type === 'generateVideo'
      ? state.nodes.length + 1 + (videoRank.get(id) ?? nodeRank.get(id))
      : (nodeRank.get(id) ?? 0);
  };
  const q = state.nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id),
    out = [];
  while (q.length) {
    q.sort((a, b) => priority(a) - priority(b));
    const id = q.shift();
    out.push(id);
    for (const target of outgoing.get(id)) {
      indeg.set(target, indeg.get(target) - 1);
      if (indeg.get(target) === 0) q.push(target);
    }
  }
  if (out.length !== state.nodes.length) throw new Error('Workflow contains a cycle. Remove the loop first.');
  return out;
}

export function requiredNodeOrder(targetId) {
  const required = new Set();
  const visit = id => {
    if (required.has(id)) return;
    required.add(id);
    for (const edge of state.edges.filter(item => item.target === id)) visit(edge.source);
    const node = nodeById(id),
      previous = node?.type === 'generateVideo' && node.data?.continuity ? timelinePredecessor(id) : null;
    if (previous) visit(previous.id);
  };
  visit(targetId);
  return topoOrder().filter(id => required.has(id));
}
