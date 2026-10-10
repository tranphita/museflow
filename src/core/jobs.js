import { NO_RETRY_KINDS, PAUSE_KINDS, classifyError, worstKind } from './job-errors.js';

export const QUEUE_CONTROL_ID = 'queue-control';
export const LEASE_MS = 5 * 60_000;
export const HEARTBEAT_MS = 30_000;
export const WATCHDOG_MS = 15 * 60_000;
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
export const ACTIVE_STATUSES = new Set(['running', 'exporting']);
export const OPEN_STATUSES = new Set(['queued', 'running', 'exporting', 'review']);
export const PAUSE_REASONS = {
  '': 'The queue is not running. Press Start to open the worker windows.',
  user: 'Paused. Episodes that are running finish first. Press Resume to continue.',
  stop: 'Stopped. Unfinished episodes went back to the queue and continue from their last finished step.',
  credits: 'Muse ran out of credits. Top up, then press Resume.',
  'signed-out':
    'Muse is signed out in a worker window, or the window was closed. Sign in there, then press Resume.',
  'tts-key':
    'The tvoiceai API key is missing or was rejected. Fix it in Settings → Voiceover, then press Resume.',
  breaker:
    'Three episodes in a row could not reach Muse. The Muse page may have changed. Check a worker window, then press Resume.',
};
const BREAKER_KINDS = new Set(['bridge', 'timeout']);
const BREAKER_LIMIT = 3;

export const isJob = record => Boolean(record) && record.id !== QUEUE_CONTROL_ID;

export function defaultControl() {
  return {
    id: QUEUE_CONTROL_ID,
    paused: true,
    abortRunning: false,
    reason: '',
    recentKinds: [],
    workers: 3,
    maxAttempts: 3,
    cooldownSec: 0,
    leaseMs: LEASE_MS,
    pollMs: 10_000,
    museHomeUrl: 'https://muse.ai/',
  };
}

export function createJob({ seriesId, episodeId, title, fileName, script, order }, now = Date.now()) {
  return {
    id: `job-${crypto.randomUUID()}`,
    seriesId,
    episodeId,
    title,
    fileName,
    script,
    order,
    status: 'queued',
    attempts: 0,
    notBefore: 0,
    workerId: null,
    heartbeatAt: 0,
    queuedAt: now,
    startedAt: 0,
    endedAt: 0,
    runMs: 0,
    progress: { done: 0, total: 0, current: '' },
    error: '',
    errorKind: '',
    checkpoint: null,
    outputKey: '',
  };
}

export function isLeaseExpired(job, now, leaseMs = LEASE_MS) {
  return ACTIVE_STATUSES.has(job.status) && now - (job.heartbeatAt || 0) > leaseMs;
}

export function pickNextJob(records, now, leaseMs = LEASE_MS) {
  return (
    records
      .filter(isJob)
      .filter(
        job => (job.status === 'queued' && (job.notBefore || 0) <= now) || isLeaseExpired(job, now, leaseMs),
      )
      .sort((a, b) => a.order - b.order || a.queuedAt - b.queuedAt)[0] || null
  );
}

export function claimPatch(job, workerId, now) {
  return {
    status: 'running',
    workerId: String(workerId),
    heartbeatAt: now,
    startedAt: now,
    attempts: job.attempts + 1,
  };
}

export function applyJobPatch(current, patch, owner) {
  if (!current) return null;
  if (owner !== undefined && current.workerId !== String(owner)) return null;
  return { ...current, ...(typeof patch === 'function' ? patch(current) : patch) };
}

export function nextAttempt(job, kind, now, maxAttempts = 3) {
  const released = { workerId: null, heartbeatAt: 0 };
  const refund = { attempts: Math.max(0, job.attempts - 1) };
  if (kind === 'stopped') return { patch: { ...released, status: 'queued', ...refund }, pause: null };
  if (PAUSE_KINDS.has(kind)) return { patch: { ...released, status: 'queued', ...refund }, pause: kind };
  if (NO_RETRY_KINDS.has(kind) || job.attempts >= maxAttempts)
    return { patch: { ...released, status: 'failed', endedAt: now }, pause: null };
  const wait = BACKOFF_MS[Math.min(Math.max(job.attempts, 1), BACKOFF_MS.length) - 1];
  return { patch: { ...released, status: 'queued', notBefore: now + wait }, pause: null };
}

export function runFailure(run) {
  if (!run) return { kind: 'unknown', message: 'The episode did not start.' };
  if (run.outcome === 'stopped') return { kind: 'stopped', message: 'Stopped by you.' };
  const messages = run.steps
    .filter(step => step.status === 'error')
    .map(step => step.error || 'A step failed.');
  if (run.outcome === 'error') messages.unshift(run.message || 'The episode stopped on an error.');
  if (!messages.length) return null;
  const kind = worstKind(messages.map(classifyError));
  return { kind, message: messages.find(message => classifyError(message) === kind) };
}

export function interleave(groups) {
  const result = [];
  for (let index = 0; groups.some(group => index < group.length); index++)
    for (const group of groups) if (index < group.length) result.push(group[index]);
  return result;
}

export function queueSummary(records, workers = 1) {
  const jobs = records.filter(isJob);
  const count = (...statuses) => jobs.filter(job => statuses.includes(job.status)).length;
  const recent = jobs
    .filter(job => ['review', 'done'].includes(job.status) && job.runMs > 0)
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, 10);
  const remaining = count('queued', 'running', 'exporting');
  const average = recent.length ? recent.reduce((sum, job) => sum + job.runMs, 0) / recent.length : 0;
  return {
    queued: count('queued'),
    running: count('running', 'exporting'),
    review: count('review'),
    failed: count('failed'),
    done: count('done'),
    etaMs: average && remaining ? (remaining * average) / Math.max(1, workers) : null,
  };
}

export function recordOutcome(control, kind) {
  const recentKinds = [...(control.recentKinds || []), kind].slice(-BREAKER_LIMIT);
  if (PAUSE_KINDS.has(kind)) return { ...control, recentKinds, paused: true, reason: kind };
  if (recentKinds.length === BREAKER_LIMIT && recentKinds.every(item => BREAKER_KINDS.has(item)))
    return { ...control, recentKinds: [], paused: true, reason: 'breaker' };
  return { ...control, recentKinds };
}
