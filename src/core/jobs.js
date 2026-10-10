import { NO_RETRY_KINDS, PAUSE_KINDS, classifyError, worstKind } from './job-errors.js';

export const QUEUE_CONTROL_ID = 'queue-control';
export const LEASE_MS = 5 * 60_000;
export const HEARTBEAT_MS = 30_000;
export const WATCHDOG_MS = 15 * 60_000;
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
export const ACTIVE_STATUSES = new Set(['running', 'exporting']);
export const OPEN_STATUSES = new Set(['queued', 'running', 'exporting', 'review']);
export const PAUSE_REASONS = {
  '': 'Hàng đợi chưa chạy. Bấm Bắt đầu để mở các cửa sổ worker.',
  user: 'Đã tạm dừng. Các tập đang chạy sẽ làm xong trước. Bấm Tiếp tục để chạy tiếp.',
  stop: 'Đã dừng. Các tập chưa xong đã về lại hàng đợi và sẽ chạy tiếp từ bước cuối cùng đã xong.',
  credits: 'Muse đã hết credit. Hãy nạp thêm rồi bấm Tiếp tục.',
  'signed-out':
    'Muse bị đăng xuất trong một cửa sổ worker, hoặc cửa sổ đó đã bị đóng. Hãy đăng nhập lại ở đó rồi bấm Tiếp tục; cửa sổ bị đóng sẽ tự mở lại.',
  'tts-key':
    'API key tvoiceai bị thiếu hoặc bị từ chối. Hãy sửa trong Cài đặt → Lồng tiếng rồi bấm Tiếp tục.',
  breaker:
    'Ba tập liên tiếp không kết nối được với Muse. Có thể trang Muse đã thay đổi. Hãy kiểm tra một cửa sổ worker rồi bấm Tiếp tục.',
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

export const jobOutputKey = job => `${job.seriesId}/${job.episodeId}/${job.id}`;

export function exhaustedLeases(records, now, leaseMs = LEASE_MS, maxAttempts = Infinity) {
  return records.filter(
    job => isJob(job) && isLeaseExpired(job, now, leaseMs) && job.attempts >= maxAttempts,
  );
}

export function pickNextJob(records, now, leaseMs = LEASE_MS, maxAttempts = Infinity) {
  return (
    records
      .filter(isJob)
      .filter(
        job =>
          (job.status === 'queued' && (job.notBefore || 0) <= now) ||
          (isLeaseExpired(job, now, leaseMs) && job.attempts < maxAttempts),
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

export function runFailure(run, fallbackMessage = '') {
  if (!run) {
    const message = fallbackMessage || 'Tập này chưa bắt đầu chạy.';
    return { kind: classifyError(message), message };
  }
  if (run.outcome === 'stopped') return { kind: 'stopped', message: 'Bạn đã dừng.' };
  const messages = run.steps
    .filter(step => step.status === 'error')
    .map(step => step.error || 'Một bước bị lỗi.');
  if (run.outcome === 'error') messages.unshift(run.message || 'Tập này dừng vì gặp lỗi.');
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

export function episodeView(episode, job, importedAt = 0) {
  if (!job)
    return {
      status: ['running', 'queued'].includes(episode.status) ? 'new' : episode.status,
      open: false,
      outputKey: episode.outputKey || '',
      error: ['failed', 'stopped'].includes(episode.status) ? episode.error || '' : '',
    };
  const open = OPEN_STATUSES.has(job.status);
  if (episode.status === 'changed' && !open && job.queuedAt < importedAt)
    return { status: 'changed', open: false, outputKey: job.outputKey || episode.outputKey || '', error: '' };
  return {
    status: job.status,
    open,
    outputKey: job.outputKey || episode.outputKey || '',
    error: job.error && ['failed', 'queued'].includes(job.status) ? job.error : '',
  };
}

export const workerLabel = workerId => String(workerId ?? '').split(':')[0];

export function refineKind(kind, { tabOpen, loginRequired }) {
  return ['bridge', 'timeout'].includes(kind) && (!tabOpen || loginRequired) ? 'signed-out' : kind;
}

export function planEnqueue(records, jobs) {
  const existing = records.filter(isJob);
  const key = job => `${job.seriesId}
${job.episodeId}`;
  const taken = new Set(existing.filter(job => OPEN_STATUSES.has(job.status)).map(key));
  const add = [];
  for (const job of jobs) {
    if (taken.has(key(job))) continue;
    taken.add(key(job));
    add.push(job);
  }
  const added = new Set(add.map(key));
  const remove = existing.filter(job => job.status === 'failed' && added.has(key(job))).map(job => job.id);
  return { add, remove };
}
