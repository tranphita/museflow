import { state } from '../core/state.js';
import { workflowFromScript } from '../core/film-graph.js';
import { classifyError } from '../core/job-errors.js';
import {
  HEARTBEAT_MS,
  WATCHDOG_MS,
  jobOutputKey,
  nextAttempt,
  recordOutcome,
  refineKind,
  runFailure,
} from '../core/jobs.js';
import { jobMediaPrefix, lockFinishedSteps } from '../core/checkpoint.js';
import { isMuseUrl } from '../core/worker-tabs.js';
import { $, runStatus, setRunStatus } from './dom.js';
import { dehydrateNodeMedia } from './media-store.js';
import { MESSAGE, museTabMessage, prepareMuseTab } from './muse-client.js';
import { enableWorkerMode, loadWorkflowObject, readSavedSettings, workflowSnapshot } from './persistence.js';
import { onRunStep } from './run-panel.js';
import { executeWorkflow, stopGeneration } from './runner.js';
import { exportTimelineVideo, stopTimelineExport } from './timeline-export.js';
import {
  claimJob,
  finishJob,
  getQueueControl,
  getSeries,
  updateJob,
  updateQueueControl,
} from './library-store.js';

const CHECKPOINT_DELAY_MS = 5000;
const LOST_LEASE = 'Một worker khác đã nhận tập này.';
const worker = { id: '', owner: '', museTabId: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const kindError = (message, kind) => Object.assign(new Error(message), { kind });

function banner(text) {
  $('#workerBanner').textContent = `Worker ${worker.id}: ${text}. Giữ tab này và cửa sổ Muse của nó luôn mở.`;
}

function abortRun() {
  if (state.isRunning) stopGeneration(state.activeGenerationId);
  state.generationAbortController?.abort();
  stopTimelineExport();
}

function runProgress() {
  const steps = state.run?.steps || [];
  return {
    done: steps.filter(step => !['pending', 'running'].includes(step.status)).length,
    total: steps.length,
    current: steps.find(step => step.status === 'running')?.label || '',
  };
}

async function owned(update) {
  const job = await update;
  if (!job) throw kindError(LOST_LEASE, 'lost');
  return job;
}

async function saveCheckpoint(jobId) {
  await owned(updateJob(jobId, {}, { owner: worker.owner }));
  const snapshot = workflowSnapshot();
  await dehydrateNodeMedia(snapshot.nodes, { keyPrefix: jobMediaPrefix(jobId) });
  return owned(updateJob(jobId, { checkpoint: snapshot, progress: runProgress() }, { owner: worker.owner }));
}

async function ensureMuseTab(control) {
  const tab = await chrome.tabs.get(worker.museTabId).catch(() => null);
  if (tab && isMuseUrl(tab.url || tab.pendingUrl)) return;
  const museWindow = await chrome.windows.create({
    url: control.museHomeUrl,
    focused: false,
    width: 560,
    height: 820,
  });
  worker.museTabId = museWindow.tabs[0].id;
  state.pinnedMuseTabId = worker.museTabId;
  await chrome.tabs.update(worker.museTabId, { autoDiscardable: false }).catch(() => {});
  history.replaceState(null, '', `?worker=${worker.id}&muse=${worker.museTabId}`);
}

async function museSession() {
  const tab = await chrome.tabs.get(worker.museTabId).catch(() => null);
  if (!tab) return { tabOpen: false, loginRequired: false };
  const reply = await museTabMessage({ type: MESSAGE.checkSession }, worker.museTabId, undefined, {
    onlyThisTab: true,
  }).catch(() => null);
  return { tabOpen: true, loginRequired: Boolean(reply?.loginRequired) };
}

async function openEpisode(job, control) {
  let workflow;
  if (job.checkpoint) workflow = lockFinishedSteps(structuredClone(job.checkpoint));
  else {
    const series = await getSeries(job.seriesId);
    workflow = workflowFromScript(job.script, { characterImages: series?.characters || {} });
  }
  if (!(await loadWorkflowObject(workflow, { label: job.title })))
    throw kindError('Không mở được tập này.', 'script');
  const shared = await readSavedSettings();
  state.settings = {
    ...state.settings,
    autoRetry: shared.autoRetry,
    continueOnError: shared.continueOnError,
    museTabs: 1,
    cooldownSec: control.cooldownSec,
  };
}

async function runJob(job, control) {
  const startedAt = Date.now();
  const phase = new AbortController();
  let lastProgressAt = startedAt,
    stopReason = '',
    finished = false,
    checkpointTimer = 0,
    checkpointing = Promise.resolve();
  const abortAll = reason => {
    if (finished || stopReason) return;
    stopReason = reason;
    abortRun();
    phase.abort();
  };
  const queueCheckpoint = () => {
    if (checkpointTimer) return;
    checkpointTimer = setTimeout(() => {
      checkpointTimer = 0;
      checkpointing = checkpointing.then(() => saveCheckpoint(job.id)).catch(() => {});
    }, CHECKPOINT_DELAY_MS);
  };
  const stopListening = onRunStep(step => {
    lastProgressAt = Date.now();
    if (step.status === 'done') queueCheckpoint();
  });
  const heartbeat = setInterval(
    async () => {
      const current = await updateJob(
        job.id,
        { heartbeatAt: Date.now(), progress: runProgress() },
        { owner: worker.owner },
      ).catch(() => null);
      const latest = await getQueueControl().catch(() => control);
      if (finished) return;
      if (!current) abortAll('lost');
      else if (Date.now() - lastProgressAt > WATCHDOG_MS) abortAll('watchdog');
      else if (latest.abortRunning) abortAll('stop');
    },
    Math.min(HEARTBEAT_MS, control.leaseMs / 3),
  );
  banner(`đang chạy ${job.title}`);
  try {
    await ensureMuseTab(control);
    await prepareMuseTab(worker.museTabId, control.museHomeUrl);
    await openEpisode(job, control);
    lastProgressAt = Date.now();
    state.run = null;
    await executeWorkflow();
    clearTimeout(checkpointTimer);
    checkpointTimer = 0;
    await checkpointing;
    if (stopReason === 'lost') return;
    await saveCheckpoint(job.id);
    const failure = runFailure(state.run, runStatus.textContent);
    if (failure) throw kindError(failure.message, failure.kind);
    await owned(updateJob(job.id, { status: 'exporting', heartbeatAt: Date.now() }, { owner: worker.owner }));
    banner(`đang xuất ${job.title}`);
    lastProgressAt = Date.now();
    const exported = await navigator.locks.request('museta-ffmpeg', { signal: phase.signal }, () =>
      exportTimelineVideo({ format: 'mp4', download: false }),
    );
    if (stopReason) throw kindError('Đã dừng xuất MP4.', 'stopped');
    if (!exported || !state.timelineExportUrl)
      throw kindError('Tập đã chạy xong nhưng không xuất được MP4.', 'export');
    const blob = await (await fetch(state.timelineExportUrl)).blob();
    const endedAt = Date.now();
    await owned(
      finishJob(job.id, worker.owner, jobOutputKey(job), blob, current => ({
        status: 'review',
        outputKey: jobOutputKey(job),
        endedAt,
        runMs: (current.runMs || 0) + endedAt - startedAt,
        workerId: null,
        error: '',
        errorKind: '',
        progress: runProgress(),
      })),
    );
    await updateQueueControl(current => recordOutcome(current, 'ok'));
  } catch (error) {
    if (stopReason === 'lost' || error?.kind === 'lost') return;
    let kind =
      stopReason === 'stop'
        ? 'stopped'
        : stopReason === 'watchdog'
          ? 'timeout'
          : error?.kind || classifyError(error?.message || String(error));
    const message =
      stopReason === 'watchdog'
        ? `Không có tiến triển trong ${WATCHDOG_MS / 60_000} phút nên watchdog đã dừng lượt chạy.`
        : error?.message || String(error);
    if (['bridge', 'timeout'].includes(kind)) kind = refineKind(kind, await museSession());
    const endedAt = Date.now();
    await updateJob(
      job.id,
      current => ({
        ...nextAttempt(current, kind, endedAt, control.maxAttempts).patch,
        error: message,
        errorKind: kind,
        runMs: (current.runMs || 0) + endedAt - startedAt,
      }),
      { owner: worker.owner },
    );
    if (kind !== 'stopped') await updateQueueControl(current => recordOutcome(current, kind));
  } finally {
    finished = true;
    clearInterval(heartbeat);
    clearTimeout(checkpointTimer);
    stopListening();
  }
}

export async function initWorker(params) {
  worker.id = params.get('worker');
  worker.owner = `${worker.id}:${crypto.randomUUID().slice(0, 8)}`;
  worker.museTabId = Number(params.get('muse'));
  enableWorkerMode();
  document.body.dataset.mode = 'worker';
  document.body.dataset.view = 'canvas';
  state.pinnedMuseTabId = worker.museTabId;
  $('#workerBanner').hidden = false;
  for (;;) {
    const control = await getQueueControl().catch(() => null);
    if (!control || control.paused) {
      banner(control ? 'hàng đợi đang tạm dừng' : 'đang chờ thư viện');
      await sleep(control?.pollMs || 10_000);
      continue;
    }
    const job = await claimJob(worker.owner, Date.now()).catch(() => null);
    if (!job) {
      banner('đang chờ tập mới');
      await sleep(control.pollMs);
      continue;
    }
    await runJob(job, control).catch(error =>
      setRunStatus(
        `Worker ${worker.id} không ghi được kết quả của ${job.title}: ${error?.message || error}`,
        'error',
      ),
    );
    // A fresh page frees the decoded media and undo history the finished episode left in memory.
    location.reload();
    return;
  }
}
