import { state } from '../core/state.js';
import { starter } from '../core/node-defs.js';
import { normalizeSavedGraph } from '../core/graph.js';
import { $, runStatus, backendStatus, setRunStatus } from './dom.js';
import { blobAsDataUrl } from './media.js';
import { getMedia, idbMediaPrefix, dehydrateMediaUrl, hydrateWorkflowMedia } from './media-store.js';
import { createUndoSnapshot } from './undo.js';
import { render } from './render.js';
import { syncTimelineDock } from './timeline.js';

export let autoSaveTimer = 0,
  workflowSaveQueue = Promise.resolve();
export async function saveWorkflowSnapshot() {
  const snapshot = structuredClone({
    nodes: state.nodes,
    edges: state.edges,
    groups: state.groups,
    notes: state.notes,
    settings: state.settings,
  });
  for (const node of snapshot.nodes) {
    const data = node.data || {};
    if (data.localDataUrl)
      data.localDataUrl = await dehydrateMediaUrl(data.localDataUrl, `input:${node.id}`);
    for (const field of ['asset', 'endFrame']) {
      const media = data[field];
      if (media?.url) media.url = await dehydrateMediaUrl(media.url, `${field}:${media.id || node.id}`);
    }
  }
  await chrome.storage.local.set({ museflow: snapshot });
}
export function queueWorkflowSave() {
  workflowSaveQueue = workflowSaveQueue.catch(() => {}).then(saveWorkflowSnapshot);
  return workflowSaveQueue;
}
export function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    queueWorkflowSave().catch(error => {
      if (runStatus.className !== 'error')
        setRunStatus(`Auto-save failed: ${error?.message || String(error)}`, 'error');
    });
  }, 650);
}
export async function saveState() {
  clearTimeout(autoSaveTimer);
  try {
    await queueWorkflowSave();
    setRunStatus('Saved.', 'ok');
  } catch (error) {
    setRunStatus(`Could not save workflow: ${error?.message || String(error)}`, 'error');
  }
}
export async function exportWorkflowFile() {
  const button = $('#workflowExportBtn');
  button.disabled = true;
  try {
    const workflow = structuredClone({
      nodes: state.nodes,
      edges: state.edges,
      groups: state.groups,
      notes: state.notes,
      settings: state.settings,
    });
    let externalMedia = 0;
    const packageUrl = async url => {
      if (!url || url.startsWith('data:')) return url;
      try {
        let blob;
        if (url.startsWith(idbMediaPrefix))
          blob = await getMedia(decodeURIComponent(url.slice(idbMediaPrefix.length)));
        else if (/^(?:blob:|https?:)/i.test(url)) {
          const response = await fetch(url, { credentials: 'include' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          blob = await response.blob();
        } else return url;
        if (!blob?.size) throw new Error('Media is missing or empty');
        return await blobAsDataUrl(blob);
      } catch {
        externalMedia++;
        return url;
      }
    };
    for (const node of workflow.nodes) {
      const data = node.data || {};
      if (data.localDataUrl) data.localDataUrl = await packageUrl(data.localDataUrl);
      for (const field of ['asset', 'endFrame'])
        if (data[field]?.url) data[field].url = await packageUrl(data[field].url);
    }
    const file = {
      format: '26flow-workflow',
      version: 1,
      appVersion: '0.5.0',
      exportedAt: new Date().toISOString(),
      workflow,
    };
    const blob = new Blob([JSON.stringify(file)], { type: 'application/json' }),
      url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download = `26MuseFlow-Workflow-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setRunStatus(
      externalMedia
        ? `Workflow saved; ${externalMedia} media URL(s) could not be embedded and may require the original Muse session.`
        : 'Workflow saved with media included.',
      'ok',
    );
  } catch (error) {
    setRunStatus(`Could not save workflow file: ${error?.message || String(error)}`, 'error');
  } finally {
    button.disabled = false;
  }
}
export async function importWorkflowFile(file) {
  if (!file) return;
  if (state.isRunning) {
    setRunStatus('Stop the running workflow before importing another one.', 'warn');
    return;
  }
  let parsed, workflow;
  try {
    parsed = JSON.parse(await file.text());
    workflow = parsed?.format === '26flow-workflow' ? parsed.workflow : parsed;
    if (!workflow || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges))
      throw new Error('This file does not contain a valid MuseFlow workflow.');
  } catch (error) {
    setRunStatus(`Could not import workflow: ${error?.message || String(error)}`, 'error');
    return;
  }
  if (!window.confirm('Importing this workflow will replace the current canvas. Continue?')) return;
  createUndoSnapshot('Import workflow', { preserveRuntime: false });
  const previous = {
    nodes: state.nodes,
    edges: state.edges,
    groups: state.groups,
    notes: state.notes,
    settings: state.settings,
  };
  try {
    state.nodes = workflow.nodes;
    state.edges = workflow.edges;
    state.groups = Array.isArray(workflow.groups) ? workflow.groups : [];
    state.notes = Array.isArray(workflow.notes) ? workflow.notes : [];
    state.settings = workflow.settings && typeof workflow.settings === 'object' ? workflow.settings : {};
    await hydrateWorkflowMedia();
    normalizeSavedGraph();
    state.selectedNodeIds = [];
    state.selectedNodeId = null;
    state.selectedEdgeIds = [];
    syncSettingsUI();
    render();
    await queueWorkflowSave();
    setRunStatus(`Workflow imported: ${file.name}`, 'ok');
  } catch (error) {
    state.nodes = previous.nodes;
    state.edges = previous.edges;
    state.groups = previous.groups || [];
    state.notes = previous.notes || [];
    state.settings = previous.settings;
    render();
    setRunStatus(`Could not import workflow: ${error?.message || String(error)}`, 'error');
  }
}
export async function loadState() {
  try {
    const got = await chrome.storage.local.get('museflow');
    if (got.museflow) {
      state.nodes = Array.isArray(got.museflow.nodes) ? got.museflow.nodes : [];
      state.edges = Array.isArray(got.museflow.edges) ? got.museflow.edges : [];
      state.groups = Array.isArray(got.museflow.groups) ? got.museflow.groups : [];
      state.notes = Array.isArray(got.museflow.notes) ? got.museflow.notes : [];
      state.settings = got.museflow.settings || {};
      if (!state.nodes.length) {
        const s = starter();
        state.nodes = s.nodes;
        state.edges = s.edges;
      }
    } else {
      const s = starter();
      state.nodes = s.nodes;
      state.edges = s.edges;
    }
    await hydrateWorkflowMedia();
  } catch (error) {
    const s = starter();
    state.nodes = s.nodes;
    state.edges = s.edges;
    state.groups = [];
    state.notes = [];
    setRunStatus(`Could not load saved workflow: ${error.message}`, 'error');
  }
  normalizeSavedGraph();
  syncSettingsUI();
  render();
  syncTimelineDock();
  try {
    clearTimeout(autoSaveTimer);
    await queueWorkflowSave();
  } catch (error) {
    setRunStatus(
      `Workflow is open, but media migration failed: ${error?.message || String(error)}`,
      'warn',
    );
  }
}
export async function resetState() {
  if (state.isRunning) return;
  createUndoSnapshot('Reset workflow', { preserveRuntime: false });
  const s = starter();
  state.nodes = s.nodes;
  state.edges = s.edges;
  state.groups = [];
  state.notes = [];
  state.selectedNodeIds = [];
  state.selectedNodeId = null;
  render();
  await saveState();
}
export function syncSettingsUI() {
  backendStatus.textContent = 'Muse session · v0.5.0';
}
