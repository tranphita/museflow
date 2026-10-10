import { state } from '../core/state.js';
import { workflowFromScript } from '../core/film-graph.js';
import { classifyError } from '../core/job-errors.js';
import { HEARTBEAT_MS, WATCHDOG_MS, nextAttempt, recordOutcome, runFailure } from '../core/jobs.js';
import { jobMediaPrefix, lockFinishedSteps } from '../core/checkpoint.js';
import { $, setRunStatus } from './dom.js';
import { dehydrateNodeMedia } from './media-store.js';
import { prepareMuseTab } from './muse-client.js';
import { enableWorkerMode, loadWorkflowObject, readSavedSettings, workflowSnapshot } from './persistence.js';
import { onRunStep } from './run-panel.js';
import { executeWorkflow, stopGeneration } from './runner.js';
import { exportTimelineVideo } from './timeline-export.js';
import {
  claimJob,
  getQueueControl,
  getSeries,
  saveOutput,
  updateJob,
  updateQueueControl,
} from './library-store.js';

const CHECKPOINT_DELAY_MS = 5000;
const worker = { id: '', museTabId: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const kindError = (message, kind) => Object.assign(new Error(message), { kind });

function banner(text) {
  $('#workerBanner').textContent = `Worker ${worker.id}: ${text}. Keep this tab and its Muse window open.`;
}

function abortRun() {
  if (state.isRunning) stopGeneration(state.activeGenerationId);
  state.generationAbortController?.abort();
}

function runProgress() {
  const steps = state.run?.steps || [];
  return {
    done: steps.filter(step => !['pending', 'running'].includes(step.status)).length,
    total: steps.length,
    current: steps.find(step => step.status === 'running')?.label || '',
  };
}

async function saveCheckpoint(jobId) {
  const snapshot = workflowSnapshot();
  await dehydrateNodeMedia(snapshot.nodes, { keyPrefix: jobMediaPrefix(jobId) });
  return updateJob(jobId, { checkpoint: snapshot, progress: runProgress() }, { owner: worker.id });
}

async function openEpisode(job, control) {
  let workflow;
  if (job.checkpoint) workflow = lockFinishedSteps(structuredClone(job.checkpoint));
  else {
    const series = await getSeries(job.seriesId);
    workflow = workflowFromScript(job.script, { characterImages: series?.characters || {} });
  }
  if (!(await loadWorkflowObject(workflow, { label: job.title })))
    throw kindError('Could not open this episode.', 'script');
  const shared = await readSavedSettings();
  state.settings = {
    ...state.settings,
    autoRetry: shared.autoRetry,
    museTabs: 1,
    cooldownSec: control.cooldownSec,
  };
}

async function runJob(job, control) {
  const startedAt = Date.now();
  let lastProgressAt = startedAt,
    watchdog = false,
    lostLease = false,
    checkpointTimer = 0,
    checkpointing = Promise.resolve();
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
      const owned = await updateJob(
        job.id,
        { heartbeatAt: Date.now(), progress: runProgress() },
        { owner: worker.id },
      ).catch(() => null);
      const latest = await getQueueControl().catch(() => control);
      if (!owned) lostLease = true;
      if (Date.now() - lastProgressAt > WATCHDOG_MS) watchdog = true;
      if (lostLease || watchdog || latest.abortRunning) abortRun();
    },
    Math.min(HEARTBEAT_MS, control.leaseMs / 3),
  );
  banner(`running ${job.title}`);
  try {
    await prepareMuseTab(worker.museTabId, control.museHomeUrl);
    await openEpisode(job, control);
    lastProgressAt = Date.now();
    await executeWorkflow();
    clearTimeout(checkpointTimer);
    checkpointTimer = 0;
    await checkpointing;
    if (lostLease) return;
    await saveCheckpoint(job.id);
    const failure = runFailure(state.run);
    if (failure) throw kindError(failure.message, failure.kind);
    await updateJob(job.id, { status: 'exporting', heartbeatAt: Date.now() }, { owner: worker.id });
    banner(`exporting ${job.title}`);
    lastProgressAt = Date.now();
    const exported = await navigator.locks.request('museta-ffmpeg', () =>
      exportTimelineVideo({ format: 'mp4', download: false }),
    );
    if (!exported || !state.timelineExportUrl)
      throw kindError('The episode ran but the MP4 could not be exported.', 'export');
    const outputKey = `${job.seriesId}/${job.episodeId}`;
    await saveOutput(outputKey, await (await fetch(state.timelineExportUrl)).blob());
    const endedAt = Date.now();
    await updateJob(
      job.id,
      current => ({
        status: 'review',
        outputKey,
        endedAt,
        runMs: (current.runMs || 0) + endedAt - startedAt,
        workerId: null,
        error: '',
        errorKind: '',
        progress: runProgress(),
      }),
      { owner: worker.id },
    );
    await updateQueueControl(current => recordOutcome(current, 'ok'));
  } catch (error) {
    if (lostLease) return;
    const kind = watchdog ? 'timeout' : error?.kind || classifyError(error?.message || String(error));
    const message = watchdog
      ? `No progress for ${WATCHDOG_MS / 60_000} minutes, so the watchdog stopped the run.`
      : error?.message || String(error);
    const endedAt = Date.now();
    await updateJob(
      job.id,
      current => ({
        ...nextAttempt(current, kind, endedAt, control.maxAttempts).patch,
        error: message,
        errorKind: kind,
        runMs: (current.runMs || 0) + endedAt - startedAt,
      }),
      { owner: worker.id },
    );
    if (kind !== 'stopped') await updateQueueControl(current => recordOutcome(current, kind));
  } finally {
    clearInterval(heartbeat);
    clearTimeout(checkpointTimer);
    stopListening();
  }
}

export async function initWorker(params) {
  worker.id = params.get('worker');
  worker.museTabId = Number(params.get('muse'));
  enableWorkerMode();
  document.body.dataset.mode = 'worker';
  document.body.dataset.view = 'canvas';
  state.pinnedMuseTabId = worker.museTabId;
  $('#workerBanner').hidden = false;
  for (;;) {
    const control = await getQueueControl().catch(() => null);
    if (!control || control.paused) {
      banner(control ? 'the queue is paused' : 'waiting for the library');
      await sleep(control?.pollMs || 10_000);
      continue;
    }
    const job = await claimJob(worker.id, Date.now()).catch(() => null);
    if (!job) {
      banner('waiting for episodes');
      await sleep(control.pollMs);
      continue;
    }
    await runJob(job, control).catch(error =>
      setRunStatus(`Worker ${worker.id} could not record ${job.title}: ${error?.message || error}`, 'error'),
    );
  }
}
