import { state } from '../core/state.js';
import { starter } from '../core/node-defs.js';
import { normalizeSavedGraph } from '../core/graph.js';
import { mediaRefs } from '../core/history.js';
import { MAX_WORKERS } from '../core/worker-tabs.js';
import { $, runStatus, backendStatus, setRunStatus } from './dom.js';
import { blobAsDataUrl } from './media.js';
import {
  getMedia,
  storedMediaKey,
  dehydrateNodeMedia,
  hydrateWorkflowMedia,
  pruneMedia,
} from './media-store.js';
import { createUndoSnapshot } from './undo.js';
import { render } from './render.js';
import { syncTimelineDock } from './timeline.js';
import { APP_NAME, APP_VERSION } from './app-info.js';

const STORAGE_KEY = 'museta';
const LEGACY_STORAGE_KEYS = ['museflow'];
const WORKFLOW_FORMAT = 'museta-workflow';
const LEGACY_WORKFLOW_FORMATS = ['26flow-workflow'];

const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export function workflowSnapshot() {
  return structuredClone({
    nodes: state.nodes,
    edges: state.edges,
    groups: state.groups,
    notes: state.notes,
    settings: state.settings,
  });
}

export let autoSaveTimer = 0;
let workflowSaveQueue = Promise.resolve();
let mediaPruneAllowed = false;
let workerMode = false;

export function enableWorkerMode() {
  workerMode = true;
}

async function saveWorkflowSnapshot() {
  if (workerMode) return;
  const snapshot = workflowSnapshot();
  const usedMedia = await dehydrateNodeMedia(snapshot.nodes);
  await chrome.storage.local.set({ [STORAGE_KEY]: snapshot });
  if (mediaPruneAllowed) await pruneMedia(usedMedia).catch(() => {});
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
        setRunStatus(`Không tự lưu được: ${error?.message || String(error)}`, 'error');
    });
  }, 650);
}

export async function saveState() {
  clearTimeout(autoSaveTimer);
  try {
    await queueWorkflowSave();
    setRunStatus('Đã lưu.', 'ok');
  } catch (error) {
    setRunStatus(`Không lưu được workflow: ${error?.message || String(error)}`, 'error');
  }
}

export async function exportWorkflowFile() {
  const button = $('#workflowExportBtn');
  button.disabled = true;
  try {
    const workflow = workflowSnapshot();
    let externalMedia = 0;
    const packageUrl = async url => {
      if (!url || url.startsWith('data:')) return url;
      try {
        let blob;
        const storedKey = storedMediaKey(url);
        if (storedKey !== null) blob = await getMedia(storedKey);
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
    for (const node of workflow.nodes)
      for (const ref of mediaRefs(node.data)) ref.holder[ref.key] = await packageUrl(ref.holder[ref.key]);
    const file = {
      format: WORKFLOW_FORMAT,
      version: 1,
      appVersion: APP_VERSION,
      exportedAt: new Date().toISOString(),
      workflow,
    };
    const blob = new Blob([JSON.stringify(file)], { type: 'application/json' }),
      url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download = `${APP_NAME}-Workflow-${timestamp()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setRunStatus(
      externalMedia
        ? `Đã lưu workflow; ${externalMedia} URL media không nhúng được và có thể cần phiên Muse ban đầu mới mở được.`
        : 'Đã lưu workflow kèm media.',
      'ok',
    );
  } catch (error) {
    setRunStatus(`Không lưu được file workflow: ${error?.message || String(error)}`, 'error');
  } finally {
    button.disabled = false;
  }
}

export function parseWorkflowFile(text) {
  const parsed = JSON.parse(text);
  const isWrapped = [WORKFLOW_FORMAT, ...LEGACY_WORKFLOW_FORMATS].includes(parsed?.format);
  const workflow = isWrapped ? parsed.workflow : parsed;
  if (!workflow || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges))
    throw new Error(`File này không chứa workflow ${APP_NAME} hợp lệ.`);
  return workflow;
}

export async function importWorkflowFile(file, { confirm = true } = {}) {
  if (!file) return false;
  if (state.isRunning) {
    setRunStatus('Hãy dừng workflow đang chạy trước khi nhập workflow khác.', 'warn');
    return false;
  }
  let workflow;
  try {
    workflow = parseWorkflowFile(await file.text());
  } catch (error) {
    setRunStatus(`Không nhập được workflow: ${error?.message || String(error)}`, 'error');
    return false;
  }
  if (confirm && !window.confirm('Nhập workflow này sẽ thay thế canvas hiện tại. Tiếp tục?')) return false;
  return loadWorkflowObject(workflow, { label: file.name });
}

export async function loadWorkflowObject(workflow, { label = 'workflow' } = {}) {
  if (state.isRunning) {
    setRunStatus('Hãy dừng workflow đang chạy trước khi mở workflow khác.', 'warn');
    return false;
  }
  createUndoSnapshot('Nhập workflow', { preserveRuntime: false });
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
    state.settings = normalizeSettings(workflow.settings);
    await hydrateWorkflowMedia();
    normalizeSavedGraph();
    state.selectedNodeIds = [];
    state.selectedNodeId = null;
    state.selectedEdgeIds = [];
    syncSettingsUI();
    render();
    syncTimelineDock();
    await queueWorkflowSave();
    setRunStatus(`Đã nhập workflow: ${label}`, 'ok');
    return true;
  } catch (error) {
    state.nodes = previous.nodes;
    state.edges = previous.edges;
    state.groups = previous.groups || [];
    state.notes = previous.notes || [];
    state.settings = previous.settings;
    render();
    setRunStatus(`Không nhập được workflow: ${error?.message || String(error)}`, 'error');
    return false;
  }
}

async function readSavedWorkflow() {
  const keys = [STORAGE_KEY, ...LEGACY_STORAGE_KEYS];
  const got = await chrome.storage.local.get(keys);
  const key = keys.find(item => got[item]);
  return key
    ? { saved: got[key], legacyKey: key === STORAGE_KEY ? null : key }
    : { saved: null, legacyKey: null };
}

export async function readSavedSettings() {
  const { saved } = await readSavedWorkflow();
  return normalizeSettings(saved?.settings);
}

export async function loadState() {
  let legacyKey = null;
  try {
    const result = await readSavedWorkflow();
    legacyKey = result.legacyKey;
    const saved = result.saved;
    if (saved) {
      state.nodes = Array.isArray(saved.nodes) ? saved.nodes : [];
      state.edges = Array.isArray(saved.edges) ? saved.edges : [];
      state.groups = Array.isArray(saved.groups) ? saved.groups : [];
      state.notes = Array.isArray(saved.notes) ? saved.notes : [];
      state.settings = normalizeSettings(saved.settings);
      if (!state.nodes.length) {
        const s = starter();
        state.nodes = s.nodes;
        state.edges = s.edges;
      }
    } else {
      const s = starter();
      state.nodes = s.nodes;
      state.edges = s.edges;
      state.settings = normalizeSettings();
    }
    await hydrateWorkflowMedia();
    mediaPruneAllowed = true;
  } catch (error) {
    const s = starter();
    state.nodes = s.nodes;
    state.edges = s.edges;
    state.groups = [];
    state.notes = [];
    state.settings = normalizeSettings();
    setRunStatus(`Không tải được workflow đã lưu: ${error.message}`, 'error');
  }
  normalizeSavedGraph();
  syncSettingsUI();
  render();
  syncTimelineDock();
  try {
    clearTimeout(autoSaveTimer);
    await queueWorkflowSave();
    if (legacyKey) {
      await chrome.storage.local.remove(legacyKey);
      setRunStatus(`Đã chuyển workflow từ ${legacyKey} sang ${APP_NAME}.`, 'ok');
    }
  } catch (error) {
    setRunStatus(`Workflow đã mở, nhưng không chuyển được media: ${error?.message || String(error)}`, 'warn');
  }
}

export async function resetState() {
  if (state.isRunning) return;
  createUndoSnapshot('Đặt lại workflow', { preserveRuntime: false });
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

export function normalizeSettings(settings) {
  const source = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  return {
    ...source,
    autoRetry: Math.max(0, Math.min(2, Math.round(Number(source.autoRetry) || 0))),
    continueOnError: Boolean(source.continueOnError),
    museTabs: Math.max(1, Math.min(MAX_WORKERS, Math.round(Number(source.museTabs) || 1))),
    cooldownSec: Math.max(0, Math.min(120, Math.round(Number(source.cooldownSec) || 0))),
  };
}

export function syncSettingsUI() {
  state.settings = normalizeSettings(state.settings);
  backendStatus.textContent = `Phiên Muse · ${APP_NAME} v${APP_VERSION}`;
  const retry = $('#autoRetrySetting'),
    continueOnError = $('#continueOnErrorSetting');
  if (retry) retry.value = String(state.settings.autoRetry);
  if (continueOnError) continueOnError.checked = state.settings.continueOnError;
  if ($('#museTabsSetting')) $('#museTabsSetting').value = String(state.settings.museTabs);
}

export function readSettingsUI() {
  state.settings = normalizeSettings({
    ...state.settings,
    autoRetry: $('#autoRetrySetting')?.value,
    continueOnError: $('#continueOnErrorSetting')?.checked,
    museTabs: $('#museTabsSetting')?.value,
  });
}
