# Production Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Museta produce 20+ series episodes per night unattended: a durable job queue in IndexedDB, worker tabs that each drive their own Muse window, resume-from-checkpoint after crashes, automatic retry and pausing, a Production view to watch and review, and Studio queuing instead of direct runs.

**Architecture:** Each worker is an `app.html?worker=<n>&muse=<tabId>` tab with its own in-memory `state`, so the existing runner runs unchanged inside it. Workers claim jobs from a shared `jobs` object store inside one IndexedDB transaction, checkpoint the workflow after every finished step (media under `job:<id>:` keys), and export MP4s one at a time through a Web Lock. The main tab's Production view only opens and closes workers, shows the queue, and keeps the machine awake. All decisions (job picking, retry and backoff, error classification, the pause breaker, checkpoint locking) are pure functions in `src/core/` with unit tests.

**Tech Stack:** Chrome MV3 extension, ES modules, no build step; IndexedDB; Web Locks API; `chrome.tabs`, `chrome.windows`, `chrome.power`; FFmpeg WASM (existing); `node:test` for unit tests; Playwright MCP (`browser_run_code`) for smoke tests.

**Spec:** `docs/superpowers/specs/2026-10-10-production-queue-design.md`

## Global Constraints

- No new runtime or dev dependencies; tooling stays `npx eslint@9.13.0` and `npx prettier@3.3.3` (singleQuote, printWidth 110, arrowParens avoid).
- No code comments except ones explaining a non-obvious reason; keep existing comments.
- Commit messages: plain description of the change, no `Co-Authored-By` or "Generated with" lines.
- Never commit `series/*/characters/*`, `series/*/workflows/`, or any API key. The tvoiceai key lives only in `chrome.storage.local` under `museta-secrets`.
- UI copy is English, sentence case, and describes what the user gets.
- Worker media keys start with `job:<jobId>:`; `pruneMedia` never deletes a key starting with `job:`.
- Lease 5 minutes, heartbeat 30 seconds, watchdog 15 minutes, backoff 1/5/15 minutes, default 3 attempts, default 3 workers (1–4), breaker after 3 consecutive `bridge`/`timeout` failures.
- Workers never read or write the `museta` workflow key in `chrome.storage.local`.
- MP4 export runs inside `navigator.locks.request('museta-ffmpeg', …)`.
- New manifest permission: `power`. Version becomes `0.10.0`.

## Review Focus

- **Muse window closed or signed out in the middle of the night.** Expected: the queue pauses with a reason the user can act on, and the attempt is not counted. Pinned in Task 1 (classification of the "tab was closed" and "signed out" messages) and Task 2 (`nextAttempt` keeps `attempts` for pause kinds).
- **Two workers asking for work at the same moment.** Expected: each episode runs once. Pinned in Task 2 (`pickNextJob` is deterministic) and Task 9 (smoke asserts every episode's prompts were sent exactly 4 times, apart from the resumed one).
- **A throttled or frozen worker whose lease was taken over.** Expected: the stale worker cannot overwrite the new owner's progress. Pinned in Task 2 (`applyJobPatch` refuses a patch from a non-owner).
- **The user edits and saves the main canvas while workers run.** Expected: the workers' media survives. Pinned in Task 3 (`staleMediaKeys` skips `job:` keys) and Task 9 (smoke saves the main canvas mid-run, then the resumed job still loads its checkpoint).
- **Retry after a failed scene.** Expected: only unfinished steps run again. Pinned in Task 3 (`lockFinishedSteps` locks only `success` nodes with media and leaves `error`, `running` and empty nodes unlocked).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/job-errors.js` (new) | `classifyError`, `worstKind`, `PAUSE_KINDS`, `NO_RETRY_KINDS` |
| `src/core/jobs.js` (new) | Job and queue-control records and every queue decision |
| `src/core/checkpoint.js` (new) | Job media key helpers and `lockFinishedSteps` |
| `src/app/library-store.js` | DB v2 with a `jobs` store; atomic job, control and episode updates |
| `src/app/media-store.js` | Key prefix for dehydration, prune guard, prefix delete |
| `src/app/persistence.js` | `loadWorkflowObject`, worker mode, `readSavedSettings`, `cooldownSec` setting |
| `src/app/run-panel.js` | `onRunStep` listener |
| `src/app/runner.js` | Pinned Muse tab, request cooldown, blob-to-data-URL references |
| `src/app/muse-client.js` | `prepareMuseTab` |
| `src/app/worker.js` (new) | Worker loop |
| `src/app/studio.js` | Queue episodes instead of running them; status from jobs |
| `src/app/production.js` (new) | Production view and worker management |
| `src/app/dom.js` | Shared `el` helper |
| `src/main.js` | Boot as worker or as main tab |
| `src/app/batch.js` | Deleted |
| `app.html`, `styles.css`, `manifest.json` | Views, banner, styles, permission |
| `tests/unit/job-errors.test.js`, `jobs.test.js`, `checkpoint.test.js` (new) | Unit tests |
| `tests/smoke/chrome-stub.js`, `tests/smoke/production.js` (new) | Smoke test |

---

### Task 1: Error classification

**Files:**
- Create: `src/core/job-errors.js`
- Test: `tests/unit/job-errors.test.js`

**Interfaces:**
- Produces: `classifyError(message: string) → kind`, where kind is one of `'stopped'|'refused'|'credits'|'signed-out'|'tts-key'|'script'|'bridge'|'timeout'|'export'|'unknown'`; `worstKind(kinds: string[]) → kind`; `PAUSE_KINDS: Set`; `NO_RETRY_KINDS: Set`.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/job-errors.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, worstKind, PAUSE_KINDS, NO_RETRY_KINDS } from '../../src/core/job-errors.js';

const cases = [
  ['Generation stopped by user.', 'stopped'],
  ['Muse could not generate this scene: Mình không thể tạo cảnh này, please log in again', 'refused'],
  ['Muse account has insufficient image credits.', 'credits'],
  ['Open Muse.ai and sign in, then retry.', 'signed-out'],
  ['The Muse tab for this worker was closed. Open Muse.ai and sign in, then retry.', 'signed-out'],
  ['Muse is signed out. Open Muse.ai and sign in, then retry.', 'signed-out'],
  ['Paste your tvoiceai API key in Settings → Voiceover, press Save, then run again.', 'tts-key'],
  ['Voiceover service error (HTTP 401): invalid key', 'tts-key'],
  ['Generate Video n1: connect a Prompt, Text Append, or Text Merge node first.', 'script'],
  ['End-frame continuity for n2 needs the previous Timeline clip to be generated successfully', 'script'],
  ['Could not open this episode.', 'script'],
  ['Muse message box is not visible. Open the chat composer and retry.', 'bridge'],
  ['Muse tab found, but Museta could not attach its page bridge: x', 'bridge'],
  ['Muse did not confirm the prompt submission. Check the chat box and try again', 'bridge'],
  ['Muse chat is not ready after 90 s.', 'bridge'],
  ['Muse did not confirm 2 reference images in the chat composer (upload input accepts: image/*)', 'bridge'],
  ['Timed out waiting for a new Muse video attachment. Prompt was submitted once', 'timeout'],
  ['Timed out waiting for the voiceover.', 'timeout'],
  ['FFmpeg produced an empty MP4 file.', 'export'],
  ['Something odd happened', 'unknown'],
  ['', 'unknown'],
];

test('error messages from the bridge, runner and services are classified', () => {
  for (const [message, kind] of cases) assert.equal(classifyError(message), kind, message);
});

test('the most serious kind wins and kinds are grouped by how the queue reacts', () => {
  assert.equal(worstKind(['timeout', 'credits', 'bridge']), 'credits');
  assert.equal(worstKind(['timeout', 'refused']), 'refused');
  assert.equal(worstKind([]), 'unknown');
  assert.deepEqual([...PAUSE_KINDS], ['credits', 'signed-out', 'tts-key']);
  assert.deepEqual([...NO_RETRY_KINDS], ['refused', 'script']);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test tests/unit/job-errors.test.js`
Expected: FAIL with `Cannot find module` for `src/core/job-errors.js`.

- [ ] **Step 3: Implement**

```js
// src/core/job-errors.js
export const PAUSE_KINDS = new Set(['credits', 'signed-out', 'tts-key']);
export const NO_RETRY_KINDS = new Set(['refused', 'script']);

const SEVERITY = ['credits', 'signed-out', 'tts-key', 'script', 'refused', 'bridge', 'timeout', 'export', 'unknown', 'stopped'];
// Order matters: a refusal quotes arbitrary chat text, so it is matched before words like "log in".
const PATTERNS = [
  ['stopped', /stopped by user|aborterror/i],
  ['refused', /^muse could not generate this scene/i],
  ['credits', /insufficient (?:image )?credits|out of credits/i],
  ['signed-out', /sign in|log in|signed out/i],
  ['tts-key', /tvoiceai api key|voiceover service error \(http 40[13]\)/i],
  ['script', /connect a prompt|prompt is empty|end-frame continuity|no scenes found|could not open this episode/i],
  [
    'bridge',
    /message box is (?:not visible|unsupported)|could not attach its page bridge|did not accept the prompt|did not confirm the prompt submission|bridge did not answer|chat is not ready|upload control was not found|did not confirm \d+ reference image/i,
  ],
  ['timeout', /timed out|watchdog/i],
  ['export', /mp4|ffmpeg|timeline clip/i],
];

export function classifyError(message) {
  const text = String(message || '');
  return PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] || 'unknown';
}

export function worstKind(kinds) {
  return SEVERITY.find(kind => kinds.includes(kind)) || 'unknown';
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node --test tests/unit/job-errors.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/job-errors.js tests/unit/job-errors.test.js
git commit -m "Classify run errors for the production queue"
```

---

### Task 2: Job model and queue decisions

**Files:**
- Create: `src/core/jobs.js`
- Test: `tests/unit/jobs.test.js`

**Interfaces:**
- Consumes: `classifyError`, `worstKind`, `PAUSE_KINDS`, `NO_RETRY_KINDS` from `src/core/job-errors.js`.
- Produces:
  - Constants: `QUEUE_CONTROL_ID = 'queue-control'`, `LEASE_MS`, `HEARTBEAT_MS`, `WATCHDOG_MS`, `BACKOFF_MS`, `ACTIVE_STATUSES`, `OPEN_STATUSES`, `PAUSE_REASONS`.
  - `isJob(record) → boolean`.
  - `defaultControl() → control`, with fields `{ id, paused, abortRunning, reason, recentKinds, workers, maxAttempts, cooldownSec, leaseMs, pollMs, museHomeUrl }`.
  - `createJob({ seriesId, episodeId, title, fileName, script, order }, now) → job`.
  - `isLeaseExpired(job, now, leaseMs) → boolean`.
  - `pickNextJob(records, now, leaseMs) → job | null`.
  - `claimPatch(job, workerId, now) → patch`.
  - `applyJobPatch(current, patch, owner) → job | null`.
  - `nextAttempt(job, kind, now, maxAttempts) → { patch, pause }`.
  - `runFailure(run) → { kind, message } | null`.
  - `interleave(groups) → items`.
  - `queueSummary(records, workers) → { queued, running, review, failed, done, etaMs }`.
  - `recordOutcome(control, kind) → control`.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/jobs.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKOFF_MS,
  LEASE_MS,
  QUEUE_CONTROL_ID,
  applyJobPatch,
  claimPatch,
  createJob,
  defaultControl,
  interleave,
  isLeaseExpired,
  nextAttempt,
  pickNextJob,
  queueSummary,
  recordOutcome,
  runFailure,
} from '../../src/core/jobs.js';

const job = (fields = {}) => ({
  ...createJob({ seriesId: 's', episodeId: 'ep01.txt', title: 'T', fileName: 'T.mp4', script: 'x', order: 1 }, 0),
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
  assert.deepEqual(runFailure({ outcome: 'stopped', steps: [] }), { kind: 'stopped', message: 'Stopped by you.' });
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
  assert.equal(runFailure({ outcome: 'error', message: 'Could not open this episode.', steps: [] }).kind, 'script');
  assert.equal(runFailure(null).kind, 'unknown');
});

test('episodes from several series are interleaved', () => {
  assert.deepEqual(
    interleave([
      ['A1', 'A2', 'A3'],
      ['B1'],
      ['C1', 'C2'],
    ]),
    ['A1', 'B1', 'C1', 'A2', 'C2', 'A3'],
  );
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test tests/unit/jobs.test.js`
Expected: FAIL with `Cannot find module` for `src/core/jobs.js`.

- [ ] **Step 3: Implement**

```js
// src/core/jobs.js
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
  'signed-out': 'Muse is signed out in a worker window, or the window was closed. Sign in there, then press Resume.',
  'tts-key': 'The tvoiceai API key is missing or was rejected. Fix it in Settings → Voiceover, then press Resume.',
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
  return { status: 'running', workerId: String(workerId), heartbeatAt: now, startedAt: now, attempts: job.attempts + 1 };
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
  const messages = run.steps.filter(step => step.status === 'error').map(step => step.error || 'A step failed.');
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/unit/jobs.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/jobs.js tests/unit/jobs.test.js
git commit -m "Add job records and queue decisions"
```

---

### Task 3: Checkpoint locking and job media keys

**Files:**
- Create: `src/core/checkpoint.js`
- Test: `tests/unit/checkpoint.test.js`

**Interfaces:**
- Produces:
  - `jobMediaPrefix(jobId) → 'job:<jobId>:'`.
  - `isJobMediaKey(key) → boolean`.
  - `staleMediaKeys(allKeys: string[], keepKeys: Set<string>) → string[]`.
  - `lockFinishedSteps(workflow) → workflow`. It mutates and returns the workflow.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/checkpoint.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isJobMediaKey, jobMediaPrefix, lockFinishedSteps, staleMediaKeys } from '../../src/core/checkpoint.js';

test('job media keys are namespaced and never pruned by the canvas', () => {
  assert.equal(jobMediaPrefix('job-1'), 'job:job-1:');
  assert.equal(isJobMediaKey('job:job-1:asset:a'), true);
  assert.equal(isJobMediaKey('asset:a'), false);
  assert.deepEqual(staleMediaKeys(['asset:a', 'asset:b', 'job:job-1:asset:c'], new Set(['asset:a'])), ['asset:b']);
});

test('only finished steps with media are locked for the resumed run', () => {
  const node = (id, type, data) => ({ id, type, data });
  const workflow = {
    nodes: [
      node('img', 'generateImage', { status: 'success', asset: { url: 'museta-idb:x' } }),
      node('vid', 'generateVideo', { status: 'error', asset: null }),
      node('run', 'generateVideo', { status: 'running', asset: { url: 'museta-idb:y' } }),
      node('voice', 'voiceover', { status: 'success', asset: { url: 'museta-idb:z' } }),
      node('empty', 'generateImage', { status: 'success', asset: null }),
      node('prompt', 'prompt', { text: 'hi' }),
    ],
    edges: [],
  };
  const result = lockFinishedSteps(workflow);
  assert.equal(result, workflow);
  assert.deepEqual(
    workflow.nodes.filter(item => item.data.locked).map(item => item.id),
    ['img', 'voice'],
  );
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test tests/unit/checkpoint.test.js`
Expected: FAIL with `Cannot find module` for `src/core/checkpoint.js`.

- [ ] **Step 3: Implement**

```js
// src/core/checkpoint.js
export const jobMediaPrefix = jobId => `job:${jobId}:`;
export const isJobMediaKey = key => String(key).startsWith('job:');

export function staleMediaKeys(allKeys, keepKeys) {
  return allKeys.filter(key => !keepKeys.has(key) && !isJobMediaKey(key));
}

export function lockFinishedSteps(workflow) {
  for (const node of workflow.nodes || [])
    if (node.data?.status === 'success' && node.data.asset?.url) node.data.locked = true;
  return workflow;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node --test tests/unit/checkpoint.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/checkpoint.js tests/unit/checkpoint.test.js
git commit -m "Add checkpoint locking and job media keys"
```

---

### Task 4: Job storage and media guards

**Files:**
- Modify: `src/app/library-store.js` (whole file)
- Modify: `src/app/media-store.js` (`pruneMedia`, `dehydrateNodeMedia`, plus a new `deleteMediaWithPrefix`)

**Interfaces:**
- Consumes:
  - From `src/core/jobs.js`: `QUEUE_CONTROL_ID`, `isJob`, `defaultControl`, `pickNextJob`, `claimPatch`, `applyJobPatch`.
  - From `src/core/checkpoint.js`: `staleMediaKeys`.
- Produces:
  - Existing exports, unchanged: `listSeries`, `saveSeries`, `deleteSeries`, `saveOutput`, `getOutput`, `deleteOutput`.
  - `getSeries(id) → series | undefined`.
  - `updateEpisode(seriesId, episodeId, patch) → series | null`.
  - `listJobs() → job[]` (control record excluded), `putJobs(jobs) → void`, `deleteJob(id) → void`.
  - `updateJob(id, patchOrFn, { owner } = {}) → job | null`.
  - `claimJob(workerId, now) → job | null`.
  - `getQueueControl() → control`, `updateQueueControl(patchOrFn) → control`.
  - `dehydrateNodeMedia(nodes, { keyPrefix = '' } = {}) → Set<string>`.
  - `deleteMediaWithPrefix(prefix) → number`.

- [ ] **Step 1: Replace `src/app/library-store.js`**

```js
import { QUEUE_CONTROL_ID, applyJobPatch, claimPatch, defaultControl, isJob, pickNextJob } from '../core/jobs.js';

const DB_NAME = 'museta-library';
const DB_VERSION = 2;
const SERIES = 'series';
const OUTPUTS = 'outputs';
const JOBS = 'jobs';

let dbPromise;
function db() {
  if (!dbPromise)
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(SERIES)) database.createObjectStore(SERIES, { keyPath: 'id' });
        if (!database.objectStoreNames.contains(OUTPUTS)) database.createObjectStore(OUTPUTS);
        if (!database.objectStoreNames.contains(JOBS)) database.createObjectStore(JOBS, { keyPath: 'id' });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error || new Error('Could not open the series library.'));
    });
  return dbPromise;
}

async function transact(storeName, mode, body) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    let result;
    body(tx.objectStore(storeName), value => (result = value));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Series library request failed.'));
    tx.onabort = () => reject(tx.error || new Error('Series library request was cancelled.'));
  });
}

const request = (storeName, mode, action) =>
  transact(storeName, mode, (store, done) => {
    const req = action(store);
    req.onsuccess = () => done(req.result);
  });

function modify(storeName, key, change) {
  return transact(storeName, 'readwrite', (store, done) => {
    const req = store.get(key);
    req.onsuccess = () => {
      const next = change(req.result);
      if (next) store.put(next);
      done(next || null);
    };
  });
}

export const listSeries = () => request(SERIES, 'readonly', store => store.getAll());
export const getSeries = id => request(SERIES, 'readonly', store => store.get(id));
export const saveSeries = series => request(SERIES, 'readwrite', store => store.put(series));
export const deleteSeries = id => request(SERIES, 'readwrite', store => store.delete(id));
export const saveOutput = (key, blob) => request(OUTPUTS, 'readwrite', store => store.put(blob, key));
export const getOutput = key => request(OUTPUTS, 'readonly', store => store.get(key));
export const deleteOutput = key => request(OUTPUTS, 'readwrite', store => store.delete(key));

export const updateEpisode = (seriesId, episodeId, patch) =>
  modify(SERIES, seriesId, series =>
    series
      ? {
          ...series,
          episodes: series.episodes.map(episode => (episode.id === episodeId ? { ...episode, ...patch } : episode)),
        }
      : null,
  );

export const listJobs = async () => (await request(JOBS, 'readonly', store => store.getAll())).filter(isJob);
export const deleteJob = id => request(JOBS, 'readwrite', store => store.delete(id));
export const putJobs = jobs =>
  transact(JOBS, 'readwrite', store => {
    for (const job of jobs) store.put(job);
  });
export const updateJob = (id, patch, { owner } = {}) =>
  modify(JOBS, id, current => applyJobPatch(current, patch, owner));

export async function getQueueControl() {
  return { ...defaultControl(), ...(await request(JOBS, 'readonly', store => store.get(QUEUE_CONTROL_ID))) };
}

export const updateQueueControl = patch =>
  modify(JOBS, QUEUE_CONTROL_ID, saved => {
    const current = { ...defaultControl(), ...saved };
    return { ...current, ...(typeof patch === 'function' ? patch(current) : patch), id: QUEUE_CONTROL_ID };
  });

export function claimJob(workerId, now = Date.now()) {
  return transact(JOBS, 'readwrite', (store, done) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const records = req.result || [];
      const control = { ...defaultControl(), ...records.find(record => !isJob(record)) };
      const job = control.paused ? null : pickNextJob(records, now, control.leaseMs);
      if (!job) return done(null);
      const claimed = { ...job, ...claimPatch(job, workerId, now) };
      store.put(claimed);
      done(claimed);
    };
  });
}
```

- [ ] **Step 2: Update `src/app/media-store.js`**

Add the import at the top:

```js
import { staleMediaKeys } from '../core/checkpoint.js';
```

In `pruneMedia`, replace `const stale = keys.filter(key => !keepKeys.has(key));` with:

```js
  const stale = staleMediaKeys(keys, keepKeys);
```

Replace `dehydrateNodeMedia` with:

```js
export async function dehydrateNodeMedia(nodes, { keyPrefix = '' } = {}) {
  const keep = new Set();
  for (const node of nodes)
    for (const ref of mediaRefs(node.data)) {
      const key = keyPrefix + (ref.field === 'input' ? `input:${node.id}` : `${ref.field}:${ref.id || node.id}`);
      ref.holder[ref.key] = await dehydrateMediaUrl(ref.holder[ref.key], key);
      const stored = storedMediaKey(ref.holder[ref.key]);
      if (stored !== null) keep.add(stored);
    }
  return keep;
}
```

Add after `pruneMedia`:

```js
export async function deleteMediaWithPrefix(prefix) {
  const db = await mediaDb();
  const keys = await new Promise((resolve, reject) => {
    const request = db.transaction(MEDIA_STORE, 'readonly').objectStore(MEDIA_STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  const matching = keys.filter(key => String(key).startsWith(prefix));
  if (!matching.length) return 0;
  const tx = db.transaction(MEDIA_STORE, 'readwrite');
  for (const key of matching) tx.objectStore(MEDIA_STORE).delete(key);
  await transactionDone(tx, 'Could not delete episode media.');
  return matching.length;
}
```

- [ ] **Step 3: Run the unit tests and lint**

Run: `npm test && npm run lint`
Expected: every unit test passes (63 existing plus 15 new) and lint reports no errors. The new store functions are exercised by the smoke test in Task 9.

- [ ] **Step 4: Commit**

```bash
git add src/app/library-store.js src/app/media-store.js
git commit -m "Store production jobs and keep worker media out of canvas cleanup"
```

---

### Task 5: Runtime hooks for workers

**Files:**
- Modify: `src/app/run-panel.js` (`markStep`, plus a new `onRunStep`)
- Modify: `src/app/persistence.js` (`workflowSnapshot`, `saveWorkflowSnapshot`, `importWorkflowFile`, `normalizeSettings`, plus the new exports)
- Modify: `src/app/runner.js` (`museTabPool`, `generateNode`)
- Modify: `src/app/muse-client.js` (new `prepareMuseTab`)
- Modify: `src/core/state.js` (new `pinnedMuseTabId` field)

**Interfaces:**
- Produces:
  - `onRunStep(listener: (step) => void) → unsubscribe()`.
  - `loadWorkflowObject(workflow, { label }) → Promise<boolean>`.
  - `enableWorkerMode()`.
  - `workflowSnapshot()`, now exported.
  - `readSavedSettings() → Promise<settings>`.
  - `normalizeSettings` keeps `cooldownSec` in the range 0–120.
  - `state.pinnedMuseTabId: number | null`.
  - `prepareMuseTab(tabId, url, { timeoutMs }) → Promise<void>`.

- [ ] **Step 1: `onRunStep` in `src/app/run-panel.js`**

Add below `let ticker = 0;`:

```js
const stepListeners = new Set();

export function onRunStep(listener) {
  stepListeners.add(listener);
  return () => stepListeners.delete(listener);
}
```

At the end of `markStep`, after `renderRunPanel();`, add:

```js
  for (const listener of stepListeners) listener(step);
```

- [ ] **Step 2: Persistence changes in `src/app/persistence.js`**

- Change `function workflowSnapshot()` to `export function workflowSnapshot()`.
- Add below `let mediaPruneAllowed = false;`:

```js
let workerMode = false;

export function enableWorkerMode() {
  workerMode = true;
}
```

- Make the first line of `saveWorkflowSnapshot` return early:

```js
async function saveWorkflowSnapshot() {
  if (workerMode) return;
  const snapshot = workflowSnapshot();
```

- Split `importWorkflowFile`. Everything after the confirm prompt moves into a new exported `loadWorkflowObject`:

```js
export async function importWorkflowFile(file, { confirm = true } = {}) {
  if (!file) return false;
  if (state.isRunning) {
    setRunStatus('Stop the running workflow before importing another one.', 'warn');
    return false;
  }
  let workflow;
  try {
    workflow = parseWorkflowFile(await file.text());
  } catch (error) {
    setRunStatus(`Could not import workflow: ${error?.message || String(error)}`, 'error');
    return false;
  }
  if (confirm && !window.confirm('Importing this workflow will replace the current canvas. Continue?'))
    return false;
  return loadWorkflowObject(workflow, { label: file.name });
}

export async function loadWorkflowObject(workflow, { label = 'workflow' } = {}) {
  if (state.isRunning) {
    setRunStatus('Stop the running workflow before opening another one.', 'warn');
    return false;
  }
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
    setRunStatus(`Workflow imported: ${label}`, 'ok');
    return true;
  } catch (error) {
    state.nodes = previous.nodes;
    state.edges = previous.edges;
    state.groups = previous.groups || [];
    state.notes = previous.notes || [];
    state.settings = previous.settings;
    render();
    setRunStatus(`Could not import workflow: ${error?.message || String(error)}`, 'error');
    return false;
  }
}
```

- Add after `readSavedWorkflow`:

```js
export async function readSavedSettings() {
  const { saved } = await readSavedWorkflow();
  return normalizeSettings(saved?.settings);
}
```

- In `normalizeSettings`, add after the `museTabs` line:

```js
    cooldownSec: Math.max(0, Math.min(120, Math.round(Number(source.cooldownSec) || 0))),
```

- [ ] **Step 3: Runtime state and runner in `src/core/state.js` and `src/app/runner.js`**

In `src/core/state.js`, add `pinnedMuseTabId: null,` after `generationRequestId: null,`.

In `src/app/runner.js`:
- Import `blobAsDataUrl` from `./media.js`; if `./media.js` is already imported, add it to that import list.
- Make the first line of `museTabPool` return the pinned tab:

```js
async function museTabPool() {
  if (state.pinnedMuseTabId) return [state.pinnedMuseTabId];
```

- Add these helpers above `generateNode`:

```js
const abortableDelay = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(stoppedError());
      },
      { once: true },
    );
  });

// The Muse page fetches reference images itself and cannot read blob: URLs created by the extension.
async function transferableUrl(url) {
  if (!/^blob:/i.test(url)) return url;
  return blobAsDataUrl(await (await fetch(url)).blob());
}
```

- In `generateNode`, inside the `try` block, place this immediately before `const retries = …`:

```js
    const cooldownMs = (Number(state.settings?.cooldownSec) || 0) * 1000;
    if (cooldownMs) await abortableDelay(cooldownMs, signal);
    const referenceUrls = await Promise.all(referenceImages.map(item => transferableUrl(item.url)));
```

- In the request object, replace `referenceImages: referenceImages.map(item => item.url),` with `referenceImages: referenceUrls,`.

- [ ] **Step 4: `prepareMuseTab` in `src/app/muse-client.js`**

Add at the end of the file:

```js
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function prepareMuseTab(tabId, url, { timeoutMs = 90_000 } = {}) {
  const closed = 'The Muse tab for this worker was closed. Open Muse.ai and sign in, then retry.';
  if (!(await chrome.tabs.update(tabId, { url }).catch(() => null))) throw new Error(closed);
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await wait(1000);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error(closed);
    if (tab.status !== 'complete') continue;
    last = await museTabMessage({ type: MESSAGE.checkSession }, tabId, undefined, { onlyThisTab: true }).catch(
      error => ({ ok: false, error: error?.message || String(error) }),
    );
    if (last?.loginRequired) throw new Error('Muse is signed out. Open Muse.ai and sign in, then retry.');
    if (last?.composer) return;
  }
  throw new Error(`Muse chat is not ready after ${Math.round(timeoutMs / 1000)} s. ${last?.error || ''}`.trim());
}
```

- [ ] **Step 5: Run the unit tests, lint and the existing smoke tests**

- Run `npm test && npm run lint`. Expected: everything passes.
- Start `python tests/smoke/serve.py 8765` in the background. Run `tests/smoke/smoke.js` and then `tests/smoke/export-e2e.js` through the Playwright MCP `browser_run_code` tool: paste the file content as the code, call CDP `Network.setCacheDisabled`, and close the browser between runs.
- Expected: both report the same results as before the change and an empty `errors` array.

- [ ] **Step 6: Commit**

```bash
git add src/app/run-panel.js src/app/persistence.js src/app/runner.js src/app/muse-client.js src/core/state.js
git commit -m "Add run hooks for pinned Muse tabs, cooldown and worker mode"
```

---

### Task 6: Worker loop

**Files:**
- Create: `src/app/worker.js`
- Modify: `src/main.js` (bottom init block, keydown guard, imports)
- Modify: `app.html` (worker banner)
- Modify: `styles.css` (worker mode)

**Interfaces:**
- Consumes:
  - From Tasks 1–5: `classifyError`; `HEARTBEAT_MS`, `WATCHDOG_MS`, `nextAttempt`, `recordOutcome`, `runFailure`; `jobMediaPrefix`, `lockFinishedSteps`.
  - From the stores: `claimJob`, `getQueueControl`, `getSeries`, `saveOutput`, `updateJob`, `updateQueueControl`, `dehydrateNodeMedia`.
  - From the runtime: `prepareMuseTab`, `enableWorkerMode`, `loadWorkflowObject`, `readSavedSettings`, `workflowSnapshot`, `onRunStep`, `executeWorkflow`, `stopGeneration`, `exportTimelineVideo`.
- Produces: `initWorker(params: URLSearchParams)`.

- [ ] **Step 1: Create `src/app/worker.js`**

```js
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
import { claimJob, getQueueControl, getSeries, saveOutput, updateJob, updateQueueControl } from './library-store.js';

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
  if (!(await loadWorkflowObject(workflow, { label: job.title }))) throw kindError('Could not open this episode.', 'script');
  const shared = await readSavedSettings();
  state.settings = { ...state.settings, autoRetry: shared.autoRetry, museTabs: 1, cooldownSec: control.cooldownSec };
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
```

- [ ] **Step 2: Boot as a worker in `src/main.js`**

- Add the import `import { initWorker } from './app/worker.js';`.
- Remove `import { initBatch } from './app/batch.js';`.
- Replace the init block at the bottom:

```js
initRunPanel();
initBatch();
initStudio();
loadState();
```

with:

```js
const bootParams = new URLSearchParams(location.search);
initRunPanel();
if (bootParams.has('worker')) initWorker(bootParams);
else {
  initStudio();
  loadState();
}
```

- In the `keydown` handler, replace `if (document.body.dataset.view === 'studio') return;` with:

```js
    if (document.body.dataset.view !== 'canvas' || document.body.dataset.mode === 'worker') return;
```

- Leave the `#batchBtn` element and `batch.js` in place until Task 7. With the `initBatch` call gone, the Batch button does nothing.

- [ ] **Step 3: Add the banner in `app.html`**

Add directly after the closing `</div>` of `.statusbar`:

```html
  <div id="workerBanner" class="worker-banner" role="status" hidden></div>
```

- [ ] **Step 4: Add worker styles at the end of `styles.css`**

```css
.worker-banner {
  padding: 8px 16px;
  background: #2a2140;
  color: var(--studio-text);
  font-size: 13px;
  border-bottom: 1px solid var(--studio-line);
}
.worker-banner[hidden] {
  display: none;
}
body[data-mode='worker'] .view-switch,
body[data-mode='worker'] .toolbar-tools,
body[data-mode='worker'] .toolbar-group,
body[data-mode='worker'] #runBtn {
  display: none !important;
}
```

- [ ] **Step 5: Lint, unit test and load check**

Run `npm test && npm run lint`. Then, with the server running, open `http://127.0.0.1:8765/app.html?worker=1&muse=7` in Playwright with the chrome stub as an init script.

Expected:
- The banner reads "Worker 1: the queue is paused. Keep this tab and its Muse window open."
- The toolbar shows no editing tools.
- The `pageerror` list is empty.

- [ ] **Step 6: Commit**

```bash
git add src/app/worker.js src/main.js app.html styles.css
git commit -m "Add worker tabs that claim and produce queued episodes"
```

---

### Task 7: Studio queues episodes; Batch is removed

**Files:**
- Modify: `src/app/dom.js` (add `el`)
- Modify: `src/app/studio.js`
- Modify: `app.html` (sidebar button; remove Batch button and modal)
- Modify: `styles.css` (remove `.batch-*` rules; add status styles)
- Delete: `src/app/batch.js`

**Interfaces:**
- Consumes:
  - From `src/core/jobs.js`: `createJob`, `interleave`, `OPEN_STATUSES`.
  - From the store: `listJobs`, `putJobs`, `deleteJob`.
  - From `src/core/checkpoint.js` and the media store: `jobMediaPrefix`, `deleteMediaWithPrefix`.
- Produces, from `studio.js`:
  - `setView(view)`. It also dispatches `document` event `museta:view` with `detail: view`.
  - `playOutput(key, title)` and `downloadOutput(key, fileName)`.
- Produces, from `dom.js`: `el(tag, className, text)`.

- [ ] **Step 1: Move `el` into `src/app/dom.js`**

Append to `src/app/dom.js`:

```js
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
```

In `studio.js`, delete the local `const el = …` and import `el` from `./dom.js`.

- [ ] **Step 2: Remove direct running from `src/app/studio.js`**

- Delete these functions: `runOutcome`, `runEpisode`, `runEpisodes`, `stopStudio`, `sceneGroups`, `filmStrip`, `renderRunningRow`.
- Remove `running`, `stopRequested` and `queue` from the `studio` object and add `jobs: [], jobSignature: ''`. It becomes:

```js
const studio = { series: [], selectedId: null, jobs: [], jobSignature: '' };
```

- Remove the imports that are now unused: `state`, `executeWorkflow`, `stopGeneration`, `exportTimelineVideo`, `saveOutput`. Lint lists any others.
- Add these imports:

```js
import { OPEN_STATUSES, createJob, interleave } from '../core/jobs.js';
import { jobMediaPrefix } from '../core/checkpoint.js';
import { deleteMediaWithPrefix } from './media-store.js';
import { listJobs, putJobs, deleteJob } from './library-store.js';
```

- [ ] **Step 3: Add job-aware status, queuing and refreshing to `studio.js`**

Add below `STATUS_TEXT`:

```js
const JOB_TEXT = {
  queued: 'Queued',
  running: 'Running',
  exporting: 'Exporting MP4',
  review: 'Ready to review',
  done: 'Done',
  failed: 'Needs attention',
};

function latestJob(series, episode) {
  return (
    studio.jobs
      .filter(job => job.seriesId === series.id && job.episodeId === episode.id)
      .sort((a, b) => b.queuedAt - a.queuedAt)[0] || null
  );
}

function episodeState(series, episode) {
  const job = latestJob(series, episode);
  if (!job)
    return {
      job: null,
      status: episode.status,
      text: STATUS_TEXT[episode.status] || episode.status,
      open: false,
      outputKey: episode.outputKey || '',
      error: ['failed', 'stopped'].includes(episode.status) ? episode.error : '',
    };
  const progress = job.progress?.total ? `, step ${job.progress.done}/${job.progress.total}` : '';
  return {
    job,
    status: job.status,
    text: job.status === 'running' ? `Running${progress}, worker ${job.workerId}` : JOB_TEXT[job.status],
    open: OPEN_STATUSES.has(job.status),
    outputKey: job.outputKey || episode.outputKey || '',
    error: job.error && ['failed', 'queued'].includes(job.status) ? job.error : '',
  };
}

async function refreshJobs() {
  studio.jobs = await listJobs();
  const signature = JSON.stringify(studio.jobs.map(job => [job.id, job.status, job.progress, job.workerId, job.error]));
  if (signature === studio.jobSignature) return;
  studio.jobSignature = signature;
  if (document.body.dataset.view === 'studio') renderStudio();
}

async function enqueue(pairs) {
  const fresh = pairs.filter(({ series, episode }) => !episodeState(series, episode).open);
  if (!fresh.length) return setRunStatus('Those episodes are already in the production queue.', 'warn');
  const blocked = fresh.filter(({ series, episode }) =>
    checkEpisode(episodeScript(series.bible, episode.text)).some(issue => issue.level === 'error'),
  );
  if (
    blocked.length &&
    !window.confirm(
      `${blocked.length} of these episodes ${blocked.length === 1 ? 'has' : 'have'} script problems that will likely make Muse get it wrong. Queue anyway?`,
    )
  )
    return;
  const groups = [...new Set(fresh.map(pair => pair.series))].map(series =>
    fresh.filter(pair => pair.series === series),
  );
  const start = Math.max(0, ...studio.jobs.map(job => job.order || 0)) + 1;
  const now = Date.now();
  const jobs = interleave(groups).map(({ series, episode }, index) =>
    createJob(
      {
        seriesId: series.id,
        episodeId: episode.id,
        title: `${series.name}, episode ${episode.number}: ${episode.title}`,
        fileName: `${series.name} - Tap ${String(episode.number).padStart(2, '0')} - ${episode.title}.mp4`,
        script: episodeScript(series.bible, episode.text),
        order: start + index,
      },
      now,
    ),
  );
  await putJobs(jobs);
  studio.jobSignature = '';
  await refreshJobs();
  setRunStatus(
    `Queued ${jobs.length} episode${jobs.length === 1 ? '' : 's'}. Open Production and press Start to run them.`,
    'ok',
  );
}

const unfinished = series =>
  series.episodes
    .filter(episode => {
      const current = episodeState(series, episode);
      return !current.open && current.status !== 'done';
    })
    .map(episode => ({ series, episode }));
```

- [ ] **Step 4: Rewrite the per-episode UI and player helpers in `studio.js`**

Replace the old `downloadOutput` and `playOutput` with:

```js
export async function downloadOutput(key, fileName) {
  const blob = await getOutput(key);
  if (!blob) return setRunStatus('This MP4 is no longer in the library. Queue the episode again.', 'warn');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function playOutput(key, title) {
  const blob = await getOutput(key);
  if (!blob) return setRunStatus('This MP4 is no longer in the library. Queue the episode again.', 'warn');
  const player = $('#studioPlayer');
  if (player.src) URL.revokeObjectURL(player.src);
  player.src = URL.createObjectURL(blob);
  $('#studioPlayerTitle').textContent = title;
  $('#studioPlayerModal').classList.remove('hidden');
  player.play().catch(() => {});
}
```

Replace `episodeRow` with:

```js
function episodeRow(series, episode) {
  const current = episodeState(series, episode);
  const row = el('li', `episode-row status-${current.status}`);
  const number = el('span', 'episode-number', String(episode.number).padStart(2, '0'));
  const main = el('div', 'episode-main');
  main.append(el('h3', 'episode-title', episode.title));
  const facts = el('div', 'episode-facts');
  facts.append(
    el('span', '', `${episode.scenes} scenes`),
    el('span', '', formatDuration(episode.seconds)),
    el('span', '', `${episode.lines} lines`),
  );
  const issues = checkEpisode(episodeScript(series.bible, episode.text));
  if (issues.length) facts.appendChild(issueToggle(row, issues));
  else facts.appendChild(el('span', 'check-ok', 'Script checks passed'));
  main.appendChild(facts);
  if (issues.length) main.appendChild(issueList(issues));
  if (current.error) main.appendChild(el('p', 'episode-error', current.error));
  const status = el('div', 'episode-status');
  status.append(el('span', 'status-dot'), el('span', '', current.text));
  const finishedAt = current.job?.endedAt || episode.lastRunAt;
  const tookMs = current.job?.runMs || episode.runMs || 0;
  if (finishedAt && !current.open)
    status.append(
      el(
        'small',
        '',
        `${new Date(finishedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}, took ${formatElapsed(tookMs)}`,
      ),
    );
  const actions = el('div', 'episode-actions');
  const title = `Episode ${episode.number}: ${episode.title}`;
  const fileName = `${series.name} - Tap ${String(episode.number).padStart(2, '0')} - ${episode.title}.mp4`;
  if (current.outputKey && !['running', 'exporting'].includes(current.status)) {
    const play = el('button', 'ghost', 'Play');
    play.type = 'button';
    play.onclick = () => playOutput(current.outputKey, title);
    const download = el('button', 'ghost', 'Download MP4');
    download.type = 'button';
    download.onclick = () => downloadOutput(current.outputKey, fileName);
    actions.append(play, download);
  }
  const open = el('button', 'ghost', 'Open in canvas');
  open.type = 'button';
  open.onclick = () => openInCanvas(series, episode);
  const queue = el('button', 'run-one', current.outputKey ? 'Queue again' : 'Queue');
  queue.type = 'button';
  queue.disabled = current.open;
  queue.title = current.open ? 'This episode is already in the production queue' : 'Add this episode to the production queue';
  queue.onclick = () => enqueue([{ series, episode }]);
  actions.append(open, queue);
  row.append(number, main, status, actions);
  return row;
}
```

In `renderStudio`, replace everything from `const pending = …` through the end of the `if/else` that builds the stop and run-all buttons with:

```js
  const remaining = unfinished(series);
  const queueAll = el(
    'button',
    'run-all',
    remaining.length === series.episodes.length ? 'Queue all episodes' : `Queue ${remaining.length} remaining`,
  );
  queueAll.type = 'button';
  queueAll.disabled = !remaining.length;
  queueAll.onclick = () => enqueue(remaining);
  actions.appendChild(queueAll);
```

Then, in the same function:
- Remove `refresh.disabled = Boolean(studio.running);` and `remove.disabled = Boolean(studio.running);`.
- Delete the trailing `renderRunningRow();` call.

In `renderSeriesList`, count done episodes with `episodeState(series, episode).status === 'done'` instead of reading `episode.status`.

Replace `removeSeries` with:

```js
async function removeSeries(series) {
  const jobs = studio.jobs.filter(job => job.seriesId === series.id);
  if (jobs.some(job => ['running', 'exporting'].includes(job.status)))
    return setRunStatus('Wait until this series has no episode running, or press Stop now in Production.', 'warn');
  if (
    !window.confirm(
      `Remove “${series.name}”, its queued episodes and its exported MP4s from the Studio? Files on your computer are not touched.`,
    )
  )
    return;
  for (const job of jobs) {
    await deleteJob(job.id);
    await deleteMediaWithPrefix(jobMediaPrefix(job.id)).catch(() => {});
    if (job.outputKey) await deleteOutput(job.outputKey).catch(() => {});
  }
  for (const episode of series.episodes)
    if (episode.outputKey) await deleteOutput(episode.outputKey).catch(() => {});
  await deleteSeries(series.id);
  studio.selectedId = null;
  await loadLibrary();
}
```

Replace `loadLibrary` with:

```js
async function loadLibrary() {
  studio.series = (await listSeries()).sort((a, b) => a.name.localeCompare(b.name));
  studio.jobs = await listJobs();
  if (!selected()) studio.selectedId = studio.series[0]?.id || null;
  renderStudio();
}
```

Delete `persist(series)` if nothing uses it any more; lint reports it.

In `setView`, append after the `if (view === 'studio') renderStudio();` line:

```js
  document.dispatchEvent(new CustomEvent('museta:view', { detail: view }));
```

At the end of `initStudio`, add:

```js
  $('#studioQueueAllBtn').onclick = () => enqueue(studio.series.flatMap(unfinished));
  setInterval(() => refreshJobs().catch(() => {}), 3000);
```

- [ ] **Step 5: HTML and CSS**

In `app.html`:
- Delete the `<button id="batchBtn" …>Batch</button>` line.
- Delete the whole `<div id="batchModal" …>…</div>` block.
- Inside `.studio-sidebar`, after `<ul id="studioSeriesList" class="series-list"></ul>`, add:

```html
      <button id="studioQueueAllBtn" type="button" class="ghost studio-queue-all" title="Queue every unfinished episode, alternating between series">Queue every series</button>
```

In `styles.css`:
- Delete every rule whose selector contains `batch-` or `#batch`.
- Add `.status-exporting .status-dot` to the selector list of the `.status-running .status-dot` rule.
- Add `.status-review .status-dot` to the selector list of the `.status-done .status-dot` rule.
- Append:

```css
.studio-queue-all {
  margin: 12px 16px 16px;
  width: calc(100% - 32px);
}
```

- Delete `src/app/batch.js`.

- [ ] **Step 6: Verify**

- Run `npm test && npm run lint`. Expected: pass. Also confirm `git grep -n "batch" -- src app.html styles.css` prints nothing.
- In Playwright with the chrome stub, open `app.html`, then run `page.evaluate` to call `saveSeries` from `/src/app/library-store.js`. Pass `{ id: 'demo', folder: 'demo', name: 'Demo', bible: 'TÊN BỘ: Demo', characters: {}, importedAt: 0, episodes: [{ id: 'ep01.txt', fileName: 'ep01.txt', text: 'TIÊU ĐỀ: One\n\nCẢNH 1 (0:00–0:04): A\nPrompt ảnh: a ball\nPrompt video: it rolls', number: 1, title: 'One', scenes: 1, seconds: 4, lines: 0, status: 'new' }] }`. Reload the page, open the Studio and click **Queue** on episode 1.
- Expected:
  - The status bar says "Queued 1 episode. Open Production and press Start to run them."
  - The row status reads "Queued" and its Queue button is disabled.
  - `(await import('/src/app/library-store.js')).listJobs()` returns one job whose `script` starts with the bible text.

- [ ] **Step 7: Commit**

```bash
git add -A src/app/dom.js src/app/studio.js src/app/batch.js app.html styles.css
git commit -m "Queue Studio episodes for production and remove the Batch dialog"
```

---

### Task 8: Production view

**Files:**
- Create: `src/app/production.js`
- Modify: `src/main.js` (call `initProduction`)
- Modify: `app.html` (view tab, `#production` main)
- Modify: `styles.css` (view switching, production styles)
- Modify: `manifest.json` (`power` permission)

**Interfaces:**
- Consumes:
  - From `src/core/jobs.js`: `PAUSE_REASONS`, `queueSummary`.
  - From `src/core/checkpoint.js`: `jobMediaPrefix`.
  - From the stores: `deleteJob`, `getQueueControl`, `listJobs`, `updateEpisode`, `updateJob`, `updateQueueControl`, `deleteMediaWithPrefix`.
  - From the runtime: `loadWorkflowObject`.
  - From `studio.js`: `downloadOutput`, `playOutput`, `setView`.
  - From `dom.js`: `el`, `$`, `setRunStatus`.
- Produces: `initProduction()`.

- [ ] **Step 1: Create `src/app/production.js`**

```js
import { PAUSE_REASONS, queueSummary } from '../core/jobs.js';
import { jobMediaPrefix } from '../core/checkpoint.js';
import { $, el, setRunStatus } from './dom.js';
import { deleteMediaWithPrefix } from './media-store.js';
import { loadWorkflowObject } from './persistence.js';
import { deleteJob, getQueueControl, listJobs, updateEpisode, updateJob, updateQueueControl } from './library-store.js';
import { downloadOutput, playOutput, setView } from './studio.js';

const REFRESH_MS = 2000;
const ALERT_REASONS = new Set(['credits', 'signed-out', 'tts-key', 'breaker']);
const GROUPS = [
  { key: 'active', title: 'Running', statuses: ['running', 'exporting'] },
  { key: 'review', title: 'Ready to review', statuses: ['review'] },
  { key: 'queued', title: 'Waiting', statuses: ['queued'] },
  { key: 'failed', title: 'Needs attention', statuses: ['failed'] },
  { key: 'done', title: 'Approved', statuses: ['done'] },
];
const KIND_TEXT = {
  credits: 'Out of credits',
  'signed-out': 'Signed out',
  'tts-key': 'Voice API key',
  bridge: 'Muse page',
  timeout: 'Timed out',
  refused: 'Muse refused a scene',
  script: 'Script problem',
  export: 'MP4 export',
  stopped: 'Stopped',
  unknown: 'Error',
};
const production = { jobs: [], control: null, workers: [], keepAwake: false, signature: '', settingsOpen: false };

const appUrl = () => chrome.runtime.getURL('app.html');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const formatMinutes = ms => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

function button(label, className, onClick, title = '') {
  const node = el('button', className, label);
  node.type = 'button';
  node.onclick = () => Promise.resolve(onClick()).catch(error => setRunStatus(error?.message || String(error), 'error'));
  if (title) node.title = title;
  return node;
}

async function workerTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter(tab => tab.url?.startsWith(`${appUrl()}?worker=`))
    .map(tab => {
      const params = new URL(tab.url).searchParams;
      return { tabId: tab.id, id: params.get('worker'), museTabId: Number(params.get('muse')) };
    });
}

async function openWorker(id, control) {
  const museWindow = await chrome.windows.create({
    url: control.museHomeUrl,
    focused: false,
    width: 560,
    height: 820,
    left: 40 + (Number(id) - 1) * 580,
    top: 40,
  });
  const museTabId = museWindow.tabs[0].id;
  await chrome.tabs.update(museTabId, { autoDiscardable: false });
  const tab = await chrome.tabs.create({ url: `${appUrl()}?worker=${id}&muse=${museTabId}`, active: false });
  await chrome.tabs.update(tab.id, { autoDiscardable: false });
}

async function startQueue() {
  const control = await updateQueueControl({ paused: false, abortRunning: false, reason: '', recentKinds: [] });
  const open = new Set((await workerTabs()).map(item => item.id));
  for (let id = 1; id <= control.workers; id++) if (!open.has(String(id))) await openWorker(String(id), control);
  await refresh();
}

const pauseQueue = () => updateQueueControl({ paused: true, reason: 'user' }).then(refresh);
const stopQueue = () => updateQueueControl({ paused: true, abortRunning: true, reason: 'stop' }).then(refresh);

async function closeWorkers() {
  if (
    production.jobs.some(job => ['running', 'exporting'].includes(job.status)) &&
    !window.confirm('Episodes are still running. Close the workers anyway? They continue later from their last finished step.')
  )
    return;
  for (const item of await workerTabs()) {
    await chrome.tabs.remove(item.tabId).catch(() => {});
    const muse = await chrome.tabs.get(item.museTabId).catch(() => null);
    if (muse) await chrome.windows.remove(muse.windowId).catch(() => {});
  }
  await refresh();
}

async function approve(job) {
  await updateJob(job.id, { status: 'done', checkpoint: null });
  await deleteMediaWithPrefix(jobMediaPrefix(job.id)).catch(() => {});
  await updateEpisode(job.seriesId, job.episodeId, {
    status: 'done',
    outputKey: job.outputKey,
    lastRunAt: job.endedAt,
    runMs: job.runMs,
    error: '',
  });
  await refresh();
}

async function redo(job) {
  if (!window.confirm(`Throw away this version of “${job.title}” and produce it again from the start?`)) return;
  await deleteMediaWithPrefix(jobMediaPrefix(job.id)).catch(() => {});
  const last = Math.max(0, ...production.jobs.map(item => item.order || 0));
  await updateJob(job.id, {
    status: 'queued',
    checkpoint: null,
    attempts: 0,
    notBefore: 0,
    error: '',
    errorKind: '',
    outputKey: '',
    runMs: 0,
    order: last + 1,
    progress: { done: 0, total: 0, current: '' },
  });
  await refresh();
}

const retry = job =>
  updateJob(job.id, { status: 'queued', attempts: 0, notBefore: 0, error: '', errorKind: '' }).then(refresh);

async function remove(job) {
  if (!window.confirm(`Remove “${job.title}” from the queue?`)) return;
  await deleteJob(job.id);
  await deleteMediaWithPrefix(jobMediaPrefix(job.id)).catch(() => {});
  await refresh();
}

async function move(items, index, step) {
  const job = items[index],
    other = items[index + step];
  if (!other) return;
  await updateJob(job.id, { order: other.order });
  await updateJob(other.id, { order: job.order });
  await refresh();
}

async function openInCanvas(job) {
  if (!job.checkpoint) return setRunStatus('This episode has no saved progress yet.', 'warn');
  if (await loadWorkflowObject(structuredClone(job.checkpoint), { label: job.title })) setView('canvas');
}

async function downloadApproved(items) {
  for (const job of items.filter(item => item.outputKey)) {
    await downloadOutput(job.outputKey, job.fileName);
    await new Promise(resolve => setTimeout(resolve, 400));
  }
}

async function clearApproved(items) {
  for (const job of items) await deleteJob(job.id);
  await refresh();
}

function summaryText(summary) {
  const parts = [
    `${summary.running} running`,
    `${summary.queued} waiting`,
    `${summary.review} to review`,
    `${plural(summary.done, 'approved episode')}`,
  ];
  if (summary.failed) parts.push(`${summary.failed} need${summary.failed === 1 ? 's' : ''} attention`);
  const eta = summary.etaMs ? ` About ${formatMinutes(summary.etaMs)} left.` : '';
  return `${parts.join(', ')}.${eta}`;
}

function jobDetail(job, control) {
  const progress = job.progress?.total ? `step ${job.progress.done} of ${job.progress.total}` : 'starting';
  const elapsed = job.startedAt ? `, ${formatMinutes(Date.now() - job.startedAt)} so far` : '';
  if (job.status === 'running')
    return `Worker ${job.workerId}, ${progress}${job.progress?.current ? `: ${job.progress.current}` : ''}${elapsed}`;
  if (job.status === 'exporting') return `Worker ${job.workerId}, exporting the MP4`;
  if (job.status === 'queued' && job.notBefore > Date.now())
    return `Retry ${job.attempts + 1} of ${control.maxAttempts} at ${new Date(job.notBefore).toLocaleTimeString([], { timeStyle: 'short' })}`;
  if (job.status === 'queued') return job.attempts ? `Continues from its last finished step` : 'Waiting for a worker';
  if (job.status === 'failed') return `Stopped after ${plural(job.attempts, 'attempt')}`;
  return `Took ${formatMinutes(job.runMs || 0)} over ${plural(job.attempts, 'attempt')}`;
}

function jobRow(job, key, items, index, control) {
  const row = el('li', `job-row job-${job.status}`);
  const main = el('div', 'job-main');
  main.append(el('h3', 'job-title', job.title), el('p', 'job-detail', jobDetail(job, control)));
  if (job.error && ['failed', 'queued'].includes(job.status))
    main.appendChild(el('p', 'job-error', `${KIND_TEXT[job.errorKind] || 'Error'}: ${job.error}`));
  const actions = el('div', 'job-actions');
  if (key === 'review' || key === 'done')
    actions.append(
      button('Play', 'ghost', () => playOutput(job.outputKey, job.title)),
      button('Download', 'ghost', () => downloadOutput(job.outputKey, job.fileName)),
    );
  if (key === 'review' || key === 'failed')
    actions.append(button('Open in canvas', 'ghost', () => openInCanvas(job), 'Fix single scenes by hand'));
  if (key === 'review')
    actions.append(
      button('Redo', 'ghost', () => redo(job), 'Throw this version away and produce the episode again'),
      button('Approve', 'primary', () => approve(job)),
    );
  if (key === 'failed') actions.append(button('Retry', 'primary', () => retry(job), 'Continue from the last finished step'));
  if (key === 'queued') {
    const up = button('↑', 'ghost', () => move(items, index, -1), 'Run earlier');
    const down = button('↓', 'ghost', () => move(items, index, 1), 'Run later');
    up.disabled = index === 0;
    down.disabled = index === items.length - 1;
    up.setAttribute('aria-label', 'Run earlier');
    down.setAttribute('aria-label', 'Run later');
    actions.append(up, down);
  }
  if (key === 'queued' || key === 'failed') actions.append(button('Remove', 'ghost', () => remove(job)));
  row.append(main, actions);
  return row;
}

function groupSection(group, items, control) {
  const section = el('section', `job-group job-group-${group.key}`);
  const head = el('div', 'job-group-head');
  head.append(el('h2', '', `${group.title} (${items.length})`));
  if (group.key === 'done')
    head.append(
      button('Download all', 'ghost', () => downloadApproved(items)),
      button('Clear list', 'ghost', () => clearApproved(items), 'Remove approved episodes from this list; their MP4s stay in the Studio'),
    );
  const list = el('ol', 'job-list');
  list.append(...items.map((job, index) => jobRow(job, group.key, items, index, control)));
  section.append(head, list);
  return section;
}

function settingsPanel(control) {
  const details = el('details', 'production-settings');
  details.open = production.settingsOpen;
  details.ontoggle = () => (production.settingsOpen = details.open);
  details.append(el('summary', '', 'Queue settings'));
  const clamp = (min, max) => value => Math.max(min, Math.min(max, Math.round(Number(value) || min)));
  const field = (label, key, attrs, parse) => {
    const wrap = el('label', 'production-field');
    const input = el('input');
    Object.assign(input, attrs);
    input.value = String(control[key]);
    input.onchange = () => updateQueueControl({ [key]: parse(input.value) }).then(refresh);
    wrap.append(el('span', '', label), input);
    return wrap;
  };
  details.append(
    field('Workers', 'workers', { type: 'number', min: 1, max: 4 }, clamp(1, 4)),
    field('Attempts per episode', 'maxAttempts', { type: 'number', min: 1, max: 5 }, clamp(1, 5)),
    field('Pause between Muse requests, in seconds', 'cooldownSec', { type: 'number', min: 0, max: 120 }, clamp(0, 120)),
    field('New chat URL', 'museHomeUrl', { type: 'url' }, value =>
      /^https:\/\/(?:[a-z0-9-]+\.)*muse\.ai\//i.test(value) ? value : 'https://muse.ai/',
    ),
  );
  return details;
}

function workerStrip(control) {
  const strip = el('ul', 'worker-strip');
  strip.setAttribute('aria-label', 'Workers');
  const count = Math.max(control.workers, production.workers.length);
  for (let id = 1; id <= count; id++) {
    const live = production.workers.find(item => item.id === String(id));
    const job = production.jobs.find(
      item => ['running', 'exporting'].includes(item.status) && item.workerId === String(id),
    );
    const stale = job && Date.now() - job.heartbeatAt > control.leaseMs;
    const item = el('li', `worker-chip ${!live ? 'is-off' : stale ? 'is-stale' : job ? 'is-busy' : 'is-idle'}`);
    const text = !live
      ? 'Closed'
      : stale
        ? 'Not responding'
        : job
          ? job.title
          : control.paused
            ? 'Paused'
            : 'Waiting for an episode';
    item.append(el('span', 'status-dot'), el('strong', '', `Worker ${id}`), el('span', 'worker-chip-text', text));
    strip.appendChild(item);
  }
  return strip;
}

function render(summary) {
  const root = $('#production'),
    control = production.control;
  const header = el('header', 'production-header');
  const titles = el('div', 'production-titles');
  titles.append(el('h1', '', 'Production'), el('p', '', summaryText(summary)));
  const actions = el('div', 'production-actions');
  if (control.paused)
    actions.append(
      button(control.reason ? 'Resume' : 'Start', 'primary', startQueue, 'Open the worker windows and produce queued episodes'),
    );
  else
    actions.append(
      button('Pause', 'ghost', pauseQueue, 'Finish the episodes that are running, then stop taking new ones'),
      button('Stop now', 'danger', stopQueue, 'Stop running episodes now; they continue from their last finished step'),
    );
  actions.append(button('Close workers', 'ghost', closeWorkers, 'Close the worker tabs and their Muse windows'));
  header.append(titles, actions);
  const parts = [header];
  if (control.paused)
    parts.push(
      el(
        'p',
        `production-banner${ALERT_REASONS.has(control.reason) ? ' is-alert' : ''}`,
        PAUSE_REASONS[control.reason] || PAUSE_REASONS[''],
      ),
    );
  parts.push(workerStrip(control), settingsPanel(control));
  for (const group of GROUPS) {
    const items = production.jobs
      .filter(job => group.statuses.includes(job.status))
      .sort((a, b) => (group.key === 'done' ? b.endedAt - a.endedAt : a.order - b.order));
    if (items.length) parts.push(groupSection(group, items, control));
  }
  if (!production.jobs.length) {
    const empty = el('div', 'studio-empty');
    empty.append(
      el('h2', '', 'Nothing in the queue yet'),
      el('p', '', 'Queue episodes from the Studio. They run here one per worker, and finished MP4s wait for your review.'),
      button('Go to Studio', 'primary', () => setView('studio')),
    );
    parts.push(empty);
  }
  root.replaceChildren(...parts);
}

function syncKeepAwake(summary, control) {
  const wanted = !control.paused && summary.queued + summary.running > 0;
  if (wanted === production.keepAwake) return;
  production.keepAwake = wanted;
  if (wanted) chrome.power?.requestKeepAwake('system');
  else chrome.power?.releaseKeepAwake();
}

async function refresh() {
  const [jobs, control, workers] = await Promise.all([listJobs(), getQueueControl(), workerTabs()]);
  Object.assign(production, { jobs, control, workers });
  const summary = queueSummary(jobs, Math.max(1, workers.length));
  syncKeepAwake(summary, control);
  if (document.body.dataset.view !== 'production') return;
  const signature = JSON.stringify([
    control,
    workers,
    jobs.map(job => [job.id, job.status, job.progress, job.workerId, job.error, job.order, job.attempts, job.heartbeatAt]),
  ]);
  if (signature === production.signature) return;
  production.signature = signature;
  render(summary);
}

export function initProduction() {
  document.addEventListener('museta:view', event => {
    if (event.detail !== 'production') return;
    production.signature = '';
    refresh().catch(() => {});
  });
  setInterval(() => refresh().catch(() => {}), REFRESH_MS);
  refresh().catch(error => setRunStatus(`Could not read the production queue: ${error?.message || error}`, 'error'));
}
```

- [ ] **Step 2: Wire it up**

`src/main.js`: import `initProduction` from `./app/production.js` and call it in the non-worker branch, after `initStudio()`:

```js
else {
  initStudio();
  initProduction();
  loadState();
}
```

`app.html`:
- Between the Studio and Canvas tabs of `.view-switch`, add:

```html
      <button type="button" role="tab" data-view="production" aria-selected="false">Production</button>
```

- After the closing `</main>` of `#studio`, add:

```html
  <main id="production" class="production" aria-label="Production queue" aria-live="polite"></main>
```

`manifest.json`: change `"permissions": ["storage", "tabs", "scripting"]` to `"permissions": ["storage", "tabs", "scripting", "power"]`.

- [ ] **Step 3: Styles**

In `styles.css`:
- Replace the five `body[data-view='studio'] …` selectors in the hide rule with `body:not([data-view='canvas']) #viewport`, `body:not([data-view='canvas']) #timelineDock`, `body:not([data-view='canvas']) #timelinePreviewPanel`, `body:not([data-view='canvas']) .run-panel` and `body:not([data-view='canvas']) .canvas-only`.
- Replace `body[data-view='studio'] .toolbar-actions` with `body:not([data-view='canvas']) .toolbar-actions`.
- Replace `body[data-view='canvas'] #studio { display: none; }` with:

```css
body:not([data-view='studio']) #studio,
body:not([data-view='production']) #production {
  display: none;
}
```

- For every rule whose selector starts with `.studio button` (about lines 2871–2909), add the same selector with `.production` in place of `.studio`. Example: `.studio button.primary` becomes `.studio button.primary, .production button.primary`.
- Append:

```css
.production {
  height: calc(100vh - 86px);
  overflow: auto;
  padding: 28px clamp(16px, 4vw, 48px) 48px;
  background: var(--studio-bg);
  color: var(--studio-text);
}
.production-header {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 18px;
}
.production-titles h1 {
  margin: 0 0 4px;
  font-size: 26px;
}
.production-titles p {
  margin: 0;
  color: var(--studio-muted);
}
.production-actions {
  display: flex;
  gap: 8px;
}
.production-banner {
  margin: 0 0 18px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--studio-raised);
  border: 1px solid var(--studio-line);
}
.production-banner.is-alert {
  border-color: var(--studio-bad);
  color: #ffd7d7;
}
.worker-strip {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
  list-style: none;
  padding: 0;
  margin: 0 0 16px;
}
.worker-chip {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 8px;
  align-items: center;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--studio-raised);
  border: 1px solid var(--studio-line);
  font-size: 13px;
}
.worker-chip-text {
  color: var(--studio-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.worker-chip.is-busy .status-dot {
  background: var(--studio-ok);
}
.worker-chip.is-stale .status-dot {
  background: var(--studio-bad);
}
.worker-chip.is-idle .status-dot {
  background: var(--studio-warn);
}
.worker-chip.is-off {
  opacity: 0.55;
}
.production-settings {
  margin-bottom: 22px;
  color: var(--studio-muted);
}
.production-settings summary {
  cursor: pointer;
}
.production-field {
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
  margin: 10px 16px 0 0;
  font-size: 12px;
}
.production-field input {
  width: 220px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--studio-line);
  background: #0e1016;
  color: var(--studio-text);
}
.job-group {
  margin-top: 22px;
}
.job-group-head {
  display: flex;
  gap: 8px;
  align-items: center;
}
.job-group-head h2 {
  margin: 0 auto 0 0;
  font-size: 15px;
}
.job-list {
  list-style: none;
  padding: 0;
  margin: 10px 0 0;
  border: 1px solid var(--studio-line);
  border-radius: 12px;
  overflow: hidden;
}
.job-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--studio-raised);
}
.job-row + .job-row {
  border-top: 1px solid var(--studio-line);
}
.job-title {
  margin: 0;
  font-size: 14px;
}
.job-detail {
  margin: 2px 0 0;
  color: var(--studio-muted);
  font-size: 12px;
}
.job-error {
  margin: 6px 0 0;
  color: var(--studio-bad);
  font-size: 12px;
}
.job-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.job-group-active .job-row {
  box-shadow: inset 3px 0 0 var(--studio-ok);
}
```

- [ ] **Step 4: Verify**

- Run `npm test && npm run lint`. Expected: pass.
- In Playwright with the stub, open `app.html` and click the Production tab.
- Expected:
  - The empty state reads "Nothing in the queue yet".
  - The banner reads "The queue is not running. Press Start to open the worker windows."
  - Three worker chips read "Closed".
  - At 390px width there is no horizontal scrollbar: `document.documentElement.scrollWidth <= innerWidth`.

- [ ] **Step 5: Commit**

```bash
git add src/app/production.js src/main.js app.html styles.css manifest.json
git commit -m "Add the Production view for the episode queue"
```

---

### Task 9: End-to-end smoke test

**Files:**
- Modify: `tests/smoke/chrome-stub.js`
- Create: `tests/smoke/production.js`

**Interfaces:**
- Consumes: everything above, through the browser.

- [ ] **Step 1: Extend the chrome stub**

In `tests/smoke/chrome-stub.js`:
- Add these methods to the `tabs` object:

```js
      async get(id) {
        return { id, status: 'complete', url: 'https://muse.ai/chat', windowId: 1 };
      },
      async update(id) {
        return { id };
      },
      async create({ url }) {
        window.__createdTabs = [...(window.__createdTabs || []), url];
        return { id: 900 + window.__createdTabs.length };
      },
      async remove() {},
```

- Add these objects next to `scripting`:

```js
    windows: {
      async create() {
        window.__createdWindows = (window.__createdWindows || 0) + 1;
        return { id: window.__createdWindows, tabs: [{ id: 800 + window.__createdWindows }] };
      },
      async remove() {},
    },
    power: {
      requestKeepAwake(level) {
        window.__keepAwake = level;
        window.__keepAwakeEver = true;
      },
      releaseKeepAwake() {
        window.__keepAwake = null;
      },
    },
```

- [ ] **Step 2: Write `tests/smoke/production.js`**

```js
async page => {
  const base = 'http://127.0.0.1:8765';
  const context = page.context();
  const stub = await (await fetch(`${base}/tests/smoke/chrome-stub.js`)).text();
  await context.addInitScript(stub);
  await context.addInitScript(() => {
    const frame = (size, color) => {
      const [w, h] = String(size || '1:1').split(':').map(Number);
      const canvas = document.createElement('canvas');
      canvas.width = (w || 1) * 20;
      canvas.height = (h || 1) * 20;
      const context2d = canvas.getContext('2d');
      context2d.fillStyle = color;
      context2d.fillRect(0, 0, canvas.width, canvas.height);
      return canvas;
    };
    const clips = {};
    const recordClip = async size => {
      const canvas = frame(size, '#36c');
      const recorder = new MediaRecorder(canvas.captureStream(24), { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const stopped = new Promise(resolve => (recorder.onstop = resolve));
      recorder.start(100);
      const started = performance.now();
      const context2d = canvas.getContext('2d');
      while (performance.now() - started < 1500) {
        context2d.fillStyle = `hsl(${Math.round(performance.now() / 10) % 360} 60% 50%)`;
        context2d.fillRect(0, 0, 20, 20);
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      recorder.stop();
      await stopped;
      return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
    };
    window.__museTabs = [
      { id: 7, url: 'https://muse.ai/chat' },
      { id: 8, url: 'https://muse.ai/chat' },
    ];
    window.__museReply = async message => {
      if (/CHECK_SESSION$/.test(message.type)) return { ok: true, signedIn: true, composer: true };
      if (!/GENERATE$/.test(message.type)) return { ok: true };
      if (localStorage.getItem('smoke-mode') === 'credits')
        return { ok: false, error: 'Muse account has insufficient image credits.' };
      const title = /title:(\w+)/.exec(message.prompt)?.[1] || 'unknown';
      const counts = JSON.parse(localStorage.getItem('smoke-counts') || '{}');
      counts[title] = (counts[title] || 0) + 1;
      localStorage.setItem('smoke-counts', JSON.stringify(counts));
      await new Promise(resolve => setTimeout(resolve, Number(localStorage.getItem('smoke-delay') || 300)));
      if (message.mediaType === 'video') return { ok: true, url: (clips[message.size] ||= await recordClip(message.size)) };
      return { ok: true, url: frame(message.size, '#c63').toDataURL('image/png') };
    };
  });
  const errors = [];
  const watch = target => target.on('pageerror', error => errors.push(`${target.url()}: ${error}`));
  watch(page);
  context.on('page', watch);
  const until = async (label, predicate, timeout = 240000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await page.evaluate(predicate);
      if (value) return value;
      await page.waitForTimeout(500);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };

  await page.goto(`${base}/app.html`);
  await page.evaluate(async () => {
    sessionStorage.clear();
    localStorage.clear();
    localStorage.setItem('museta-view', 'production');
    localStorage.setItem('smoke-delay', '4000');
    for (const name of ['museta-library', 'museflow-media'])
      await new Promise(resolve => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = request.onerror = request.onblocked = resolve;
      });
  });
  await page.reload();
  await page.waitForTimeout(800);

  await page.evaluate(async () => {
    const store = await import('/src/app/library-store.js');
    const { createJob, interleave } = await import('/src/core/jobs.js');
    const scene = (title, n) =>
      `CẢNH ${n} (0:0${(n - 1) * 2}–0:0${n * 2}): Shot ${n}\nPrompt ảnh: A red ball on a table, title:${title} shot ${n}\nPrompt video: The ball rolls slowly, title:${title} shot ${n}`;
    const script = (seriesId, title) =>
      `TÊN BỘ: ${seriesId}\n\nTIÊU ĐỀ: ${title}\n\n${scene(title, 1)}\n\n${scene(title, 2)}`;
    for (const id of ['smoke-a', 'smoke-b'])
      await store.saveSeries({ id, folder: id, name: id, bible: `TÊN BỘ: ${id}`, characters: {}, episodes: [], importedAt: 0 });
    const groups = [
      [
        ['smoke-a', 'ep01.txt', 'A1'],
        ['smoke-a', 'ep02.txt', 'A2'],
      ],
      [['smoke-b', 'ep01.txt', 'B1']],
    ];
    await store.putJobs(
      interleave(groups).map(([seriesId, episodeId, title], index) =>
        createJob({ seriesId, episodeId, title, fileName: `${title}.mp4`, script: script(seriesId, title), order: index + 1 }),
      ),
    );
    await store.updateQueueControl({ paused: false, leaseMs: 6000, pollMs: 500, workers: 2 });
  });

  const openWorker = async (id, muse) => {
    const worker = await context.newPage();
    await worker.goto(`${base}/app.html?worker=${id}&muse=${muse}`);
    return worker;
  };
  const worker1 = await openWorker(1, 7);
  await openWorker(2, 8);

  const killed = await until('worker 1 to checkpoint two finished steps', async () => {
    const jobs = await (await import('/src/app/library-store.js')).listJobs();
    const job = jobs.find(
      item =>
        item.workerId === '1' &&
        item.status === 'running' &&
        (item.checkpoint?.nodes || []).filter(node => /^generate/.test(node.type) && node.data.status === 'success')
          .length >= 2,
    );
    return job ? { id: job.id, title: job.title } : null;
  });
  await page.evaluate(async () => (await import('/src/app/persistence.js')).queueWorkflowSave());
  await worker1.close();

  const finished = await until('all three episodes to reach review', async () => {
    const store = await import('/src/app/library-store.js');
    const jobs = await store.listJobs();
    if (jobs.length !== 3 || !jobs.every(job => job.status === 'review')) return null;
    const sizes = [];
    for (const job of jobs) sizes.push((await store.getOutput(job.outputKey))?.size || 0);
    return jobs.map((job, index) => ({ title: job.title, attempts: job.attempts, size: sizes[index] }));
  });
  const counts = await page.evaluate(() => JSON.parse(localStorage.getItem('smoke-counts') || '{}'));

  await page.evaluate(async () => {
    localStorage.setItem('smoke-mode', 'credits');
    const store = await import('/src/app/library-store.js');
    const { createJob } = await import('/src/core/jobs.js');
    await store.putJobs([
      createJob({
        seriesId: 'smoke-b',
        episodeId: 'ep02.txt',
        title: 'C1',
        fileName: 'C1.mp4',
        script: 'TÊN BỘ: smoke-b\n\nCẢNH 1 (0:00–0:02): x\nPrompt ảnh: title:C1 a ball',
        order: 10,
      }),
    ]);
  });
  const paused = await until('the queue to pause on missing credits', async () => {
    const store = await import('/src/app/library-store.js');
    const control = await store.getQueueControl();
    const job = (await store.listJobs()).find(item => item.title === 'C1');
    return control.paused ? { reason: control.reason, status: job.status, attempts: job.attempts, kind: job.errorKind } : null;
  });
  await page.waitForTimeout(2500);
  const ui = await page.evaluate(() => ({
    rows: document.querySelectorAll('#production .job-row').length,
    banner: document.querySelector('#production .production-banner')?.textContent || '',
    keepAwakeEver: Boolean(window.__keepAwakeEver),
  }));

  const pass =
    finished.every(item => item.size > 0) &&
    counts[killed.title.replace(/\W/g, '')] <= 6 &&
    Object.entries(counts)
      .filter(([title]) => title !== killed.title && title !== 'C1')
      .every(([, count]) => count === 4) &&
    finished.find(item => item.title === killed.title).attempts === 2 &&
    paused.reason === 'credits' &&
    paused.status === 'queued' &&
    paused.attempts === 0 &&
    ui.rows === 4 &&
    /credits/i.test(ui.banner) &&
    ui.keepAwakeEver &&
    errors.length === 0;
  return { pass, killed, finished, counts, paused, ui, errors };
}
```

- [ ] **Step 3: Run it**

- Start `python tests/smoke/serve.py 8765` in the background.
- Open a fresh Playwright browser, call CDP `Network.setCacheDisabled({ cacheDisabled: true })` on the page, and run the file content with `browser_run_code`.
- Expected: `pass: true`; for the killed title, `counts` is at most 6; every other title is exactly 4; `errors: []`.
- If it fails, fix the cause in the owning task's code. Do not loosen an assertion.
- Close the browser afterwards.

- [ ] **Step 4: Re-run the older smoke tests**

Run `tests/smoke/smoke.js` and then `tests/smoke/export-e2e.js` the same way, each in a fresh browser. Expected: unchanged results and no errors.

- [ ] **Step 5: Commit**

```bash
git add tests/smoke/chrome-stub.js tests/smoke/production.js
git commit -m "Add a production queue smoke test with worker crash and credit pause"
```

---

### Task 10: Docs, version, package, and a real run

**Files:**
- Modify: `README.md`, `README-vi.md`, `series/README.md` (replace Batch and "Run" wording with the Production workflow)
- Modify: `manifest.json`, `package.json`, `VERSION.txt` (version `0.10.0`)
- Regenerate: `downloads/Museta-extension.zip`

- [ ] **Step 1: Update the docs**

In each README:
- Replace the Batch section with a "Production queue" section. It explains, in order:
  1. Queue episodes in the Studio: **Queue**, **Queue all episodes**, **Queue every series**.
  2. Open **Production**, check **Queue settings** (Workers, Attempts, Pause between Muse requests, New chat URL), then press **Start**. One Muse window and one worker tab open per worker; sign in to Muse in each window the first time.
  3. Leave Chrome open overnight. The machine stays awake while the queue runs.
  4. In the morning, review: **Play**, **Approve**, **Redo**, **Open in canvas**, **Download all**.
  5. What pauses the queue (credits, signed out, voice API key, three Muse failures in a row) and that **Resume** continues from the last finished step.
- `README-vi.md` and `series/README.md` get the same content in Vietnamese.

- [ ] **Step 2: Bump the version and package**

- Set `"version": "0.10.0"` in `manifest.json` and `package.json`, and update `VERSION.txt` to `0.10.0`.
- Run `npm test && npm run lint`, then commit.
- Run `npm run package` and commit the regenerated zip separately. The packaged zip must come from the commit that contains the code.

```bash
git add README.md README-vi.md series/README.md manifest.json package.json VERSION.txt
git commit -m "Document the production queue and bump Museta to 0.10.0"
npm run package
git add downloads/Museta-extension.zip
git commit -m "Rebuild Museta 0.10.0 extension ZIP"
```

- [ ] **Step 3: Real Muse run with the channel owner**

This needs the owner's signed-in Muse account. Ask the owner to:
1. Reload the extension in `chrome://extensions`.
2. In the Studio, **Update from folder** both series.
3. Queue 3 episodes.
4. In Production, set Workers to 2 and press **Start**.

Confirm with them:
- Each Muse window opens a fresh chat at the New chat URL. If `https://muse.ai/` lands on a page without a message box, the worker reports "Muse chat is not ready". Ask for the URL of a new chat and set it in Queue settings.
- Both workers produce clips at the same time, and each Muse window shows only its own prompts.
- All 3 episodes reach **Ready to review** with correct MP4s, and **Approve** marks them Done in the Studio.
- Closing one Muse window mid-run pauses the queue with the "signed out or closed" banner, and **Resume** reopens the missing worker and continues.

Record the outcome in the final report. Do not mark the plan complete until the owner confirms this run.
