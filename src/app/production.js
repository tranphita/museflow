import { PAUSE_REASONS, queueSummary } from '../core/jobs.js';
import { jobMediaPrefix } from '../core/checkpoint.js';
import { $, el, setRunStatus } from './dom.js';
import { deleteMediaWithPrefix } from './media-store.js';
import { loadWorkflowObject } from './persistence.js';
import {
  deleteJob,
  getQueueControl,
  listJobs,
  updateEpisode,
  updateJob,
  updateQueueControl,
} from './library-store.js';
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
const production = {
  jobs: [],
  control: null,
  workers: [],
  keepAwake: false,
  signature: '',
  settingsOpen: false,
};

const appUrl = () => chrome.runtime.getURL('app.html');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const formatMinutes = ms => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

function button(label, className, onClick, title = '') {
  const node = el('button', className, label);
  node.type = 'button';
  node.onclick = () =>
    Promise.resolve(onClick()).catch(error => setRunStatus(error?.message || String(error), 'error'));
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
  const control = await updateQueueControl({
    paused: false,
    abortRunning: false,
    reason: '',
    recentKinds: [],
  });
  const open = new Set((await workerTabs()).map(item => item.id));
  for (let id = 1; id <= control.workers; id++)
    if (!open.has(String(id))) await openWorker(String(id), control);
  await refresh();
}

const pauseQueue = () => updateQueueControl({ paused: true, reason: 'user' }).then(refresh);
const stopQueue = () =>
  updateQueueControl({ paused: true, abortRunning: true, reason: 'stop' }).then(refresh);

async function closeWorkers() {
  if (
    production.jobs.some(job => ['running', 'exporting'].includes(job.status)) &&
    !window.confirm(
      'Episodes are still running. Close the workers anyway? They continue later from their last finished step.',
    )
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
  if (!window.confirm(`Throw away this version of “${job.title}” and produce it again from the start?`))
    return;
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
    plural(summary.done, 'approved episode'),
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
  if (job.status === 'queued')
    return job.attempts ? 'Continues from its last finished step' : 'Waiting for a worker';
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
  if (key === 'failed')
    actions.append(button('Retry', 'primary', () => retry(job), 'Continue from the last finished step'));
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
      button(
        'Clear list',
        'ghost',
        () => clearApproved(items),
        'Remove approved episodes from this list; their MP4s stay in the Studio',
      ),
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
    field(
      'Pause between Muse requests, in seconds',
      'cooldownSec',
      { type: 'number', min: 0, max: 120 },
      clamp(0, 120),
    ),
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
    const item = el(
      'li',
      `worker-chip ${!live ? 'is-off' : stale ? 'is-stale' : job ? 'is-busy' : 'is-idle'}`,
    );
    const text = !live
      ? 'Closed'
      : stale
        ? 'Not responding'
        : job
          ? job.title
          : control.paused
            ? 'Paused'
            : 'Waiting for an episode';
    item.append(
      el('span', 'status-dot'),
      el('strong', '', `Worker ${id}`),
      el('span', 'worker-chip-text', text),
    );
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
      button(
        control.reason ? 'Resume' : 'Start',
        'primary',
        startQueue,
        'Open the worker windows and produce queued episodes',
      ),
    );
  else
    actions.append(
      button('Pause', 'ghost', pauseQueue, 'Finish the episodes that are running, then stop taking new ones'),
      button(
        'Stop now',
        'danger',
        stopQueue,
        'Stop running episodes now; they continue from their last finished step',
      ),
    );
  actions.append(
    button('Close workers', 'ghost', closeWorkers, 'Close the worker tabs and their Muse windows'),
  );
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
      el(
        'p',
        '',
        'Queue episodes from the Studio. They run here one per worker, and finished MP4s wait for your review.',
      ),
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
    jobs.map(job => [
      job.id,
      job.status,
      job.progress,
      job.workerId,
      job.error,
      job.order,
      job.attempts,
      job.heartbeatAt,
    ]),
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
  refresh().catch(error =>
    setRunStatus(`Could not read the production queue: ${error?.message || error}`, 'error'),
  );
}
