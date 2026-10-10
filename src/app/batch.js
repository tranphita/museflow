import { state } from '../core/state.js';
import { $, setRunStatus } from './dom.js';
import { importWorkflowFile } from './persistence.js';
import { executeWorkflow, stopGeneration } from './runner.js';
import { exportTimelineVideo } from './timeline-export.js';

const ICONS = { waiting: '○', running: '⏳', done: '✓', failed: '✗', stopped: '■' };
const batch = { items: [], running: false, stopRequested: false };

const baseName = name => name.replace(/\.workflow\.json$|\.json$/i, '');
const formatTime = ms => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

function renderBatch() {
  const list = $('#batchList');
  list.replaceChildren(
    ...batch.items.map((item, index) => {
      const row = document.createElement('li');
      row.className = `batch-item batch-${item.status}`;
      const icon = document.createElement('span');
      icon.textContent = ICONS[item.status];
      const name = document.createElement('span');
      name.className = 'batch-name';
      name.textContent = item.file.name;
      const time = document.createElement('span');
      time.className = 'batch-time';
      time.textContent = item.startedAt ? formatTime((item.endedAt || Date.now()) - item.startedAt) : '';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = 'Remove from the queue';
      remove.disabled = batch.running;
      remove.onclick = () => {
        batch.items.splice(index, 1);
        renderBatch();
      };
      row.append(icon, name, time, remove);
      if (item.message) {
        const message = document.createElement('div');
        message.className = 'batch-message';
        message.textContent = item.message;
        row.appendChild(message);
      }
      return row;
    }),
  );
  $('#batchEmpty').classList.toggle('hidden', batch.items.length > 0);
  $('#batchStartBtn').disabled = batch.running || !batch.items.some(item => item.status === 'waiting');
  $('#batchStopBtn').classList.toggle('hidden', !batch.running);
  $('#batchAddBtn').disabled = batch.running;
  const done = batch.items.filter(item => item.status === 'done').length;
  $('#batchSummary').textContent = batch.items.length
    ? `${done}/${batch.items.length} workflows finished${batch.running ? ' · running…' : ''}`
    : '';
}

function runOutcome() {
  const run = state.run;
  if (!run) return { status: 'failed', message: 'The workflow did not start.' };
  if (run.outcome === 'stopped') return { status: 'stopped', message: 'Stopped by you.' };
  if (run.outcome === 'error')
    return { status: 'failed', message: run.message || 'The workflow stopped on an error.' };
  const failed = run.steps.filter(step => step.status === 'error').length;
  return failed
    ? {
        status: 'failed',
        message: `${failed} step${failed === 1 ? '' : 's'} failed: ${run.steps.find(step => step.status === 'error').error}`,
      }
    : { status: 'done', message: '' };
}

async function runItem(item) {
  item.status = 'running';
  item.startedAt = Date.now();
  item.message = 'Importing…';
  renderBatch();
  if (!(await importWorkflowFile(item.file, { confirm: false }))) {
    item.status = 'failed';
    item.message = 'Could not import this file.';
    return;
  }
  item.message = 'Generating…';
  renderBatch();
  await executeWorkflow();
  const outcome = runOutcome();
  item.status = outcome.status;
  item.message = outcome.message;
  if (outcome.status === 'stopped' || batch.stopRequested) return;
  if ($('#batchExport').checked) {
    item.message = [outcome.message, 'Exporting MP4…'].filter(Boolean).join(' · ');
    renderBatch();
    const exported = await exportTimelineVideo({ format: 'mp4', fileName: baseName(item.file.name) });
    item.message = [
      outcome.message,
      exported ? `Saved ${baseName(item.file.name)}.mp4` : 'MP4 export failed or had no clips.',
    ]
      .filter(Boolean)
      .join(' · ');
    if (!exported && item.status === 'done') item.status = 'failed';
  }
}

async function startBatch() {
  if (batch.running || state.isRunning) {
    setRunStatus('Wait for the current run to finish before starting the queue.', 'warn');
    return;
  }
  batch.running = true;
  batch.stopRequested = false;
  const ticker = setInterval(renderBatch, 1000);
  renderBatch();
  try {
    for (const item of batch.items) {
      if (batch.stopRequested) break;
      if (item.status !== 'waiting') continue;
      await runItem(item);
      item.endedAt = Date.now();
      renderBatch();
      if (item.status === 'stopped') break;
      if (item.status === 'failed' && $('#batchStopOnFail').checked) break;
    }
  } finally {
    clearInterval(ticker);
    batch.running = false;
    renderBatch();
    const done = batch.items.filter(item => item.status === 'done').length;
    setRunStatus(
      `Queue finished: ${done}/${batch.items.length} workflows completed.`,
      done === batch.items.length ? 'ok' : 'warn',
    );
  }
}

function stopBatch() {
  batch.stopRequested = true;
  if (state.isRunning) stopGeneration(state.activeGenerationId);
  state.generationAbortController?.abort();
  setRunStatus('Stopping the queue after the current step…', 'warn');
}

function addFiles(files) {
  for (const file of files)
    batch.items.push({ file, status: 'waiting', message: '', startedAt: 0, endedAt: 0 });
  batch.items.sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true }));
  renderBatch();
}

export function initBatch() {
  $('#batchBtn').onclick = () => {
    $('#batchModal').classList.remove('hidden');
    renderBatch();
  };
  $('#batchCloseBtn').onclick = () => $('#batchModal').classList.add('hidden');
  $('#batchAddBtn').onclick = () => $('#batchFileInput').click();
  $('#batchFileInput').onchange = event => {
    addFiles([...(event.target.files || [])]);
    event.target.value = '';
  };
  $('#batchClearBtn').onclick = () => {
    if (batch.running) return;
    batch.items = batch.items.filter(item => item.status === 'waiting');
    renderBatch();
  };
  $('#batchStartBtn').onclick = startBatch;
  $('#batchStopBtn').onclick = stopBatch;
}
