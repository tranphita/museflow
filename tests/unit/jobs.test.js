import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKOFF_MS,
  LEASE_MS,
  QUEUE_CONTROL_ID,
  applyJobPatch,
  episodeView,
  exhaustedLeases,
  jobOutputKey,
  claimPatch,
  createJob,
  defaultControl,
  interleave,
  isLeaseExpired,
  nextAttempt,
  pickNextJob,
  planEnqueue,
  refineKind,
  workerLabel,
  queueSummary,
  recordOutcome,
  runFailure,
} from '../../src/core/jobs.js';

const job = (fields = {}) => ({
  ...createJob(
    { seriesId: 's', episodeId: 'ep01.txt', title: 'T', fileName: 'T.mp4', script: 'x', order: 1 },
    0,
  ),
  ...fields,
});

test('a new job is queued with an empty run history', () => {
  const created = createJob(
    { seriesId: 's', episodeId: 'e', title: 'T', fileName: 'T.mp4', script: 'S', order: 4 },
    1000,
  );
  assert.match(created.id, /^job-/);
  assert.equal(created.status, 'queued');
  assert.equal(created.attempts, 0);
  assert.equal(created.queuedAt, 1000);
  assert.equal(created.script, 'S');
  assert.equal(created.checkpoint, null);
  assert.deepEqual(created.progress, { done: 0, total: 0, current: '' });
});

test('the lowest order that is ready runs next; backoff and the control record are skipped', () => {
  const records = [
    { ...defaultControl() },
    job({ id: 'late', order: 3 }),
    job({ id: 'waiting', order: 1, notBefore: 5000 }),
    job({ id: 'ready', order: 2 }),
    job({ id: 'done', order: 0, status: 'review' }),
  ];
  assert.equal(pickNextJob(records, 1000).id, 'ready');
  assert.equal(pickNextJob(records, 6000).id, 'waiting');
  assert.equal(pickNextJob([{ ...defaultControl() }], 0), null);
});

test('a running job whose worker stopped sending heartbeats can be claimed again', () => {
  const stale = job({ id: 'stale', status: 'running', heartbeatAt: 0, order: 9 });
  assert.equal(isLeaseExpired(stale, LEASE_MS - 1), false);
  assert.equal(isLeaseExpired(stale, LEASE_MS + 1), true);
  assert.equal(pickNextJob([stale], LEASE_MS + 1).id, 'stale');
  assert.equal(pickNextJob([stale], 7000, 5000).id, 'stale');
  assert.equal(isLeaseExpired(job({ status: 'review', heartbeatAt: 0 }), LEASE_MS * 10), false);
});

test('claiming sets the owner and counts the attempt', () => {
  assert.deepEqual(claimPatch(job({ attempts: 1 }), 2, 50), {
    status: 'running',
    workerId: '2',
    heartbeatAt: 50,
    startedAt: 50,
    attempts: 2,
  });
});

test('only the owning worker can patch a job', () => {
  const owned = job({ workerId: '1', heartbeatAt: 1 });
  assert.equal(applyJobPatch(owned, { heartbeatAt: 2 }, '2'), null);
  assert.equal(applyJobPatch(owned, { heartbeatAt: 2 }, '1').heartbeatAt, 2);
  assert.equal(applyJobPatch(owned, current => ({ attempts: current.attempts + 5 })).attempts, 5);
  assert.equal(applyJobPatch(null, { a: 1 }), null);
});

test('retryable failures back off, then fail after the last attempt', () => {
  const first = nextAttempt(job({ attempts: 1, workerId: '1' }), 'timeout', 1000, 3);
  assert.deepEqual(first, {
    patch: { workerId: null, heartbeatAt: 0, status: 'queued', notBefore: 1000 + BACKOFF_MS[0] },
    pause: null,
  });
  assert.equal(nextAttempt(job({ attempts: 2 }), 'bridge', 0, 3).patch.notBefore, BACKOFF_MS[1]);
  assert.equal(nextAttempt(job({ attempts: 3 }), 'bridge', 0, 4).patch.notBefore, BACKOFF_MS[2]);
  assert.equal(nextAttempt(job({ attempts: 3 }), 'unknown', 9, 3).patch.status, 'failed');
});

test('script and refusal failures fail at once; account problems pause without using an attempt', () => {
  assert.equal(nextAttempt(job({ attempts: 1 }), 'refused', 9, 3).patch.status, 'failed');
  assert.equal(nextAttempt(job({ attempts: 1 }), 'script', 9, 3).patch.endedAt, 9);
  const paused = nextAttempt(job({ attempts: 2 }), 'signed-out', 9, 3);
  assert.deepEqual(paused, {
    patch: { workerId: null, heartbeatAt: 0, status: 'queued', attempts: 1 },
    pause: 'signed-out',
  });
  assert.equal(nextAttempt(job({ attempts: 1 }), 'stopped', 9, 3).patch.attempts, 0);
});

test('run results become a failure kind with the message that explains it', () => {
  assert.equal(runFailure({ outcome: 'done', steps: [{ status: 'done' }, { status: 'kept' }] }), null);
  assert.deepEqual(runFailure({ outcome: 'stopped', steps: [] }), {
    kind: 'stopped',
    message: 'Bạn đã dừng.',
  });
  assert.deepEqual(
    runFailure({
      outcome: 'done',
      steps: [
        { status: 'error', error: 'Timed out waiting for a new Muse image attachment.' },
        { status: 'skipped', error: 'Skipped: it needs x' },
        { status: 'error', error: 'Muse account has insufficient image credits.' },
      ],
    }),
    { kind: 'credits', message: 'Muse account has insufficient image credits.' },
  );
  assert.equal(
    runFailure({ outcome: 'error', message: 'Could not open this episode.', steps: [] }).kind,
    'script',
  );
  assert.equal(runFailure(null).kind, 'unknown');
});

test('episodes from several series are interleaved', () => {
  assert.deepEqual(interleave([['A1', 'A2', 'A3'], ['B1'], ['C1', 'C2']]), [
    'A1',
    'B1',
    'C1',
    'A2',
    'C2',
    'A3',
  ]);
});

test('the summary counts jobs and estimates the remaining time from recent runs', () => {
  const records = [
    { ...defaultControl() },
    job({ status: 'review', runMs: 600, endedAt: 2 }),
    job({ status: 'done', runMs: 1200, endedAt: 1 }),
    job({ status: 'queued' }),
    job({ status: 'queued' }),
    job({ status: 'running' }),
    job({ status: 'exporting' }),
    job({ status: 'failed' }),
  ];
  assert.deepEqual(queueSummary(records, 2), {
    queued: 2,
    running: 2,
    review: 1,
    failed: 1,
    done: 1,
    etaMs: (4 * 900) / 2,
  });
  assert.equal(queueSummary([job()], 1).etaMs, null);
});

test('account problems and three Muse failures in a row pause the queue', () => {
  const control = { ...defaultControl(), paused: false };
  assert.equal(control.id, QUEUE_CONTROL_ID);
  assert.deepEqual(recordOutcome(control, 'credits'), {
    ...control,
    recentKinds: ['credits'],
    paused: true,
    reason: 'credits',
  });
  let next = recordOutcome(recordOutcome(control, 'bridge'), 'timeout');
  assert.equal(next.paused, false);
  next = recordOutcome(next, 'bridge');
  assert.equal(next.paused, true);
  assert.equal(next.reason, 'breaker');
  assert.deepEqual(next.recentKinds, []);
  const broken = recordOutcome(recordOutcome(recordOutcome(control, 'bridge'), 'ok'), 'bridge');
  assert.equal(broken.paused, false);
});

test('each job keeps its own MP4 so a new run never overwrites an approved one', () => {
  const created = job({ id: 'job-9', seriesId: 'demo', episodeId: 'ep01.txt' });
  assert.equal(jobOutputKey(created), 'demo/ep01.txt/job-9');
});

test('a run that never started is classified from the status message', () => {
  assert.deepEqual(
    runFailure(
      null,
      'Museta 0.10.0 · Paste your tvoiceai API key in Settings → Voiceover, press Save, then run again.',
    ),
    {
      kind: 'tts-key',
      message:
        'Museta 0.10.0 · Paste your tvoiceai API key in Settings → Voiceover, press Save, then run again.',
    },
  );
});

test('a job whose workers kept dying stops being claimed once it used every attempt', () => {
  const crashing = job({ id: 'crash', status: 'running', heartbeatAt: 0, attempts: 3, order: 1 });
  const next = job({ id: 'next', order: 2 });
  assert.equal(pickNextJob([crashing, next], LEASE_MS + 1, LEASE_MS, 3).id, 'next');
  assert.deepEqual(
    exhaustedLeases([crashing, next], LEASE_MS + 1, LEASE_MS, 3).map(item => item.id),
    ['crash'],
  );
  assert.equal(pickNextJob([crashing], LEASE_MS + 1, LEASE_MS, 4).id, 'crash');
});

test('a script edited after its last run shows as changed instead of done', () => {
  const edited = { status: 'changed', outputKey: 'old' };
  assert.deepEqual(episodeView(edited, job({ status: 'done', queuedAt: 5, outputKey: 's/e/j' }), 10), {
    status: 'changed',
    open: false,
    outputKey: 's/e/j',
    error: '',
  });
  assert.equal(episodeView(edited, job({ status: 'done', queuedAt: 20 }), 10).status, 'done');
  assert.equal(episodeView(edited, job({ status: 'queued', queuedAt: 5 }), 10).open, true);
  assert.deepEqual(episodeView({ status: 'failed', error: 'x' }, null, 0), {
    status: 'failed',
    open: false,
    outputKey: '',
    error: 'x',
  });
  assert.equal(episodeView({ status: 'new' }, job({ status: 'failed', error: 'boom' }), 0).error, 'boom');
});

test('a Muse page error on a closed or signed-out tab counts as signed out', () => {
  assert.equal(refineKind('bridge', { tabOpen: false, loginRequired: false }), 'signed-out');
  assert.equal(refineKind('timeout', { tabOpen: true, loginRequired: true }), 'signed-out');
  assert.equal(refineKind('bridge', { tabOpen: true, loginRequired: false }), 'bridge');
  assert.equal(refineKind('script', { tabOpen: false, loginRequired: false }), 'script');
});

test('queuing skips episodes already in the queue and replaces their failed runs', () => {
  const failed = job({ id: 'old', seriesId: 's', episodeId: 'e1', status: 'failed' });
  const running = job({ id: 'busy', seriesId: 's', episodeId: 'e2', status: 'running' });
  const done = job({ id: 'kept', seriesId: 's', episodeId: 'e3', status: 'done' });
  const fresh = ['e1', 'e2', 'e3', 'e1'].map((episodeId, index) =>
    job({ id: `new${index}`, seriesId: 's', episodeId }),
  );
  const plan = planEnqueue([failed, running, done, { ...defaultControl() }], fresh);
  assert.deepEqual(
    plan.add.map(item => item.id),
    ['new0', 'new2'],
  );
  assert.deepEqual(plan.remove, ['old']);
});

test('worker labels drop the per-tab instance suffix', () => {
  assert.equal(workerLabel('2:ab12cd34'), '2');
  assert.equal(workerLabel('3'), '3');
  assert.equal(workerLabel(null), '');
});

test('episodes left running or queued by an older version show as not run', () => {
  assert.equal(episodeView({ status: 'running' }, null).status, 'new');
  assert.equal(episodeView({ status: 'queued' }, null).status, 'new');
  assert.equal(episodeView({ status: 'done', outputKey: 'k' }, null).status, 'done');
});
