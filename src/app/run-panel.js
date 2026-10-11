import { state } from '../core/state.js';
import { nodeDefs } from '../core/node-defs.js';
import { nodeById } from '../core/graph.js';
import { $ } from './dom.js';
import { APP_NAME } from './app-info.js';
import { applyCanvasTransform } from './viewport.js';
import { scheduleDrawEdges } from './render.js';
import { selectNode } from './editor.js';

const ICONS = { pending: '○', running: '⏳', done: '✓', error: '✗', skipped: '⏭', kept: '🔒', stopped: '■' };
const FINISHED = new Set(['done', 'error', 'skipped', 'kept', 'stopped']);
let ticker = 0;
const stepListeners = new Set();
let restartStep = null;

export function setStepRestarter(restarter) {
  restartStep = restarter;
  renderRunPanel();
}

export function onRunStep(listener) {
  stepListeners.add(listener);
  return () => stepListeners.delete(listener);
}

const formatTime = ms => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export function stepLabel(node) {
  if (!node) return 'Node đã bị xoá';
  const title = node.data.customName || nodeDefs[node.type]?.title || node.type;
  return node.data.sceneLabel && !node.data.customName ? `${title} · ${node.data.sceneLabel}` : title;
}

export function startRun(nodeIds, { single = false } = {}) {
  state.run = {
    single,
    startedAt: Date.now(),
    endedAt: 0,
    outcome: 'running',
    message: '',
    follow: state.run?.follow ?? true,
    steps: nodeIds.map(id => ({
      id,
      label: stepLabel(nodeById(id)),
      status: 'pending',
      startedAt: 0,
      endedAt: 0,
      error: '',
    })),
  };
  clearInterval(ticker);
  ticker = setInterval(tickRunPanel, 1000);
  renderRunPanel();
}

export function markStep(id, status, error = '') {
  const step = state.run?.steps.find(item => item.id === id);
  if (!step) return;
  step.status = status;
  step.error = error;
  if (status === 'running') {
    step.startedAt = Date.now();
    if (state.run.follow) focusNode(id, { select: false });
  } else if (FINISHED.has(status)) step.endedAt = Date.now();
  renderRunPanel();
  for (const listener of stepListeners) listener(step);
}

export function finishRun(outcome, message = '') {
  if (!state.run) return;
  for (const step of state.run.steps)
    if (step.status === 'running') {
      step.status = outcome === 'stopped' ? 'stopped' : 'error';
      step.endedAt = Date.now();
      if (outcome !== 'stopped' && !step.error) step.error = message;
    }
  state.run.outcome = outcome;
  state.run.message = message;
  state.run.endedAt = Date.now();
  clearInterval(ticker);
  renderRunPanel();
}

export function focusNode(id, { select = true } = {}) {
  const node = nodeById(id);
  if (!node || node.data?.dockOnly) return;
  const viewport = $('#viewport').getBoundingClientRect();
  const element = document.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
  const width = element?.offsetWidth || 270,
    height = element?.offsetHeight || 260;
  state.panX = viewport.width / 2 - (node.x + width / 2) * state.zoom;
  state.panY = viewport.height / 2 - (node.y + height / 2) * state.zoom;
  applyCanvasTransform();
  scheduleDrawEdges();
  if (select) selectNode(id);
}

function counts(run) {
  const finished = run.steps.filter(step => FINISHED.has(step.status)).length;
  const failed = run.steps.filter(step => step.status === 'error').length;
  return { finished, failed, total: run.steps.length };
}

function summary(run) {
  const { finished, failed, total } = counts(run);
  const elapsed = formatTime((run.endedAt || Date.now()) - run.startedAt);
  if (run.outcome === 'running') {
    const current = run.steps.find(step => step.status === 'running');
    return `Đang chạy ${Math.min(finished + 1, total)}/${total} · ${elapsed}${current ? ` · ${current.label}` : ''}`;
  }
  if (run.outcome === 'stopped') return `Bạn đã dừng sau ${elapsed} · ${finished}/${total} bước`;
  if (run.outcome === 'error') {
    const failedStep = run.steps.find(step => step.status === 'error');
    return `Dừng ở ${failedStep?.label || 'một bước'} sau ${elapsed}`;
  }
  return failed ? `Xong sau ${elapsed}, có ${failed} bước bị lỗi` : `Xong cả ${total} bước trong ${elapsed}`;
}

const stepClock = step => (step.startedAt ? formatTime((step.endedAt || Date.now()) - step.startedAt) : '');

function renderRunTitle(run) {
  document.title =
    run?.outcome === 'running'
      ? `▶ ${Math.min(counts(run).finished + 1, counts(run).total)}/${counts(run).total} · ${APP_NAME}`
      : APP_NAME;
}

// The step list is rebuilt only when a step changes, so its buttons stay clickable between ticks.
function tickRunPanel() {
  const run = state.run,
    list = $('#runPanelSteps');
  if (!run || !list) return;
  renderRunTitle(run);
  $('#runPanelSummary').textContent = summary(run);
  for (const step of run.steps) {
    const clock = list.querySelector(`[data-step-id="${CSS.escape(step.id)}"] .run-step-clock`);
    if (clock) clock.textContent = stepClock(step);
  }
}

export function renderRunPanel() {
  const panel = $('#runPanel'),
    run = state.run;
  if (!panel) return;
  panel.classList.toggle('hidden', !run || panel.dataset.dismissed === 'true');
  renderRunTitle(run);
  if (!run) return;
  const { finished, total } = counts(run);
  panel.className = `run-panel run-${run.outcome}${panel.classList.contains('hidden') ? ' hidden' : ''}`;
  $('#runPanelSummary').textContent = summary(run);
  $('#runPanelBar').style.width = `${total ? (finished / total) * 100 : 0}%`;
  $('#runPanelFollow').checked = run.follow;
  $('#runPanelMessage').textContent = run.outcome === 'running' ? '' : run.message;
  const list = $('#runPanelSteps');
  list.replaceChildren(
    ...run.steps.map(step => {
      const item = document.createElement('li');
      item.className = `run-step run-step-${step.status}`;
      item.dataset.stepId = step.id;
      item.title = step.error || 'Hiện node này trên canvas';
      const icon = document.createElement('span');
      icon.className = 'run-step-icon';
      icon.textContent = ICONS[step.status] || '○';
      const label = document.createElement('span');
      label.className = 'run-step-label';
      label.textContent = step.label;
      const time = document.createElement('span');
      time.className = 'run-step-time';
      const clock = document.createElement('span');
      clock.className = 'run-step-clock';
      clock.textContent = stepClock(step);
      time.appendChild(clock);
      if (restartStep && step.status === 'running' && run.outcome === 'running') {
        const restart = document.createElement('button');
        restart.type = 'button';
        restart.className = 'run-step-restart';
        restart.textContent = '↻';
        restart.title =
          'Bước này bị treo? Dừng riêng bước này và chạy lại từ đầu; các bước khác vẫn chạy tiếp.';
        restart.setAttribute('aria-label', `Dừng và chạy lại ${step.label}`);
        restart.onclick = event => {
          event.stopPropagation();
          restartStep(step.id);
        };
        time.appendChild(restart);
      }
      item.append(icon, label, time);
      if (step.error && ['error', 'skipped'].includes(step.status)) {
        const error = document.createElement('div');
        error.className = 'run-step-error';
        error.textContent = step.error;
        item.appendChild(error);
      }
      item.onclick = () => focusNode(step.id);
      return item;
    }),
  );
  list.querySelector('.run-step-running, .run-step-error')?.scrollIntoView({ block: 'nearest' });
}

export function initRunPanel() {
  $('#runPanelClose').onclick = () => {
    $('#runPanel').dataset.dismissed = 'true';
    renderRunPanel();
  };
  $('#runPanelFollow').onchange = event => {
    if (state.run) state.run.follow = event.target.checked;
  };
}

export function showRunPanel() {
  delete $('#runPanel').dataset.dismissed;
  renderRunPanel();
}
