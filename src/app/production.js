import { PAUSE_REASONS, nextAttempt, queueSummary, workerLabel } from '../core/jobs.js';
import { applySeriesSettings, jobMediaPrefix } from '../core/checkpoint.js';
import { workflowFromScript } from '../core/film-graph.js';
import { MAX_WORKERS, workerChatUrl, workerWindowBounds } from '../core/worker-tabs.js';
import { $, el, setRunStatus } from './dom.js';
import { deleteMediaWithPrefix } from './media-store.js';
import { loadWorkflowObject } from './persistence.js';
import {
  deleteJob,
  deleteOutput,
  getQueueControl,
  getSeries,
  listJobs,
  updateEpisode,
  updateJob,
  updateQueueControl,
} from './library-store.js';
import { downloadOutput, playOutput, setView } from './studio.js';

const REFRESH_MS = 2000;
const ALERT_REASONS = new Set(['credits', 'signed-out', 'tts-key', 'breaker']);
const GROUPS = [
  { key: 'active', title: 'Đang chạy', statuses: ['running', 'exporting'] },
  { key: 'review', title: 'Chờ duyệt', statuses: ['review'] },
  { key: 'queued', title: 'Đang chờ', statuses: ['queued'] },
  { key: 'failed', title: 'Cần xử lý', statuses: ['failed'] },
  { key: 'done', title: 'Đã duyệt', statuses: ['done'] },
];
const KIND_TEXT = {
  credits: 'Hết credit',
  'signed-out': 'Đã đăng xuất',
  'tts-key': 'API key giọng đọc',
  bridge: 'Trang Muse',
  timeout: 'Quá thời gian chờ',
  refused: 'Muse từ chối một cảnh',
  script: 'Lỗi kịch bản',
  export: 'Xuất MP4',
  stopped: 'Đã dừng',
  unknown: 'Lỗi',
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
const formatMinutes = ms => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} phút` : `${Math.floor(minutes / 60)} giờ ${minutes % 60} phút`;
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
    url: workerChatUrl(control.museHomeUrl),
    focused: false,
    ...workerWindowBounds(Number(id), control.workers, window.screen),
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
      'Vẫn còn tập đang chạy. Vẫn đóng worker? Các tập này sẽ chạy tiếp sau từ bước cuối cùng đã xong.',
    )
  )
    return;
  const closed = new Set();
  for (const item of await workerTabs()) {
    closed.add(item.id);
    await chrome.tabs.remove(item.tabId).catch(() => {});
    const muse = await chrome.tabs.get(item.museTabId).catch(() => null);
    if (muse) await chrome.windows.remove(muse.windowId).catch(() => {});
  }
  for (const job of production.jobs)
    if (['running', 'exporting'].includes(job.status) && closed.has(workerLabel(job.workerId)))
      await requeue(job);
  await refresh();
}

const requeue = job =>
  updateJob(job.id, current =>
    ['running', 'exporting'].includes(current.status)
      ? nextAttempt(current, 'stopped', Date.now()).patch
      : {},
  );

const isStale = (job, control) =>
  ['running', 'exporting'].includes(job.status) && Date.now() - job.heartbeatAt > control.leaseMs;

async function approve(job) {
  const series = await getSeries(job.seriesId);
  const previous = series?.episodes.find(episode => episode.id === job.episodeId)?.outputKey;
  await updateJob(job.id, { status: 'done', checkpoint: null });
  await deleteMediaWithPrefix(jobMediaPrefix(job.id)).catch(() => {});
  if (previous && previous !== job.outputKey) await deleteOutput(previous).catch(() => {});
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
  if (!window.confirm(`Bỏ phiên bản này của “${job.title}” và làm lại từ đầu?`)) return;
  await deleteMediaWithPrefix(jobMediaPrefix(job.id)).catch(() => {});
  if (job.outputKey) await deleteOutput(job.outputKey).catch(() => {});
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
  if (!window.confirm(`Xoá “${job.title}” khỏi hàng đợi?`)) return;
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
  if (!job.checkpoint) return setRunStatus('Tập này chưa có tiến độ nào được lưu.', 'warn');
  const series = await getSeries(job.seriesId);
  const fresh = workflowFromScript(job.script, {
    characterImages: series?.characters || {},
    music: series?.music || null,
  });
  const workflow = applySeriesSettings(structuredClone(job.checkpoint), fresh);
  if (await loadWorkflowObject(workflow, { label: job.title })) setView('canvas');
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
    `${summary.running} đang chạy`,
    `${summary.queued} đang chờ`,
    `${summary.review} chờ duyệt`,
    `${summary.done} tập đã duyệt`,
  ];
  if (summary.failed) parts.push(`${summary.failed} cần xử lý`);
  const eta = summary.etaMs ? ` Còn khoảng ${formatMinutes(summary.etaMs)}.` : '';
  return `${parts.join(', ')}.${eta}`;
}

function jobDetail(job, control) {
  const progress = job.progress?.total ? `bước ${job.progress.done}/${job.progress.total}` : 'đang bắt đầu';
  const elapsed = job.startedAt ? `, đã chạy ${formatMinutes(Date.now() - job.startedAt)}` : '';
  if (job.status === 'running')
    return `Worker ${workerLabel(job.workerId)}, ${progress}${job.progress?.current ? `: ${job.progress.current}` : ''}${elapsed}`;
  if (job.status === 'exporting') return `Worker ${workerLabel(job.workerId)}, đang xuất MP4`;
  if (job.status === 'queued' && job.notBefore > Date.now())
    return `Thử lại lần ${job.attempts + 1}/${control.maxAttempts} lúc ${new Date(job.notBefore).toLocaleTimeString([], { timeStyle: 'short' })}`;
  if (job.status === 'queued')
    return job.attempts ? 'Sẽ chạy tiếp từ bước cuối cùng đã xong' : 'Đang chờ worker';
  if (job.status === 'failed') return `Đã dừng sau ${job.attempts} lần thử`;
  return `Mất ${formatMinutes(job.runMs || 0)} qua ${job.attempts} lần thử`;
}

function jobRow(job, key, items, index, control) {
  const row = el('li', `job-row job-${job.status}`);
  const main = el('div', 'job-main');
  main.append(el('h3', 'job-title', job.title), el('p', 'job-detail', jobDetail(job, control)));
  if (job.error && ['failed', 'queued'].includes(job.status))
    main.appendChild(el('p', 'job-error', `${KIND_TEXT[job.errorKind] || 'Lỗi'}: ${job.error}`));
  const actions = el('div', 'job-actions');
  if (key === 'review' || key === 'done')
    actions.append(
      button('Phát', 'ghost', () => playOutput(job.outputKey, job.title)),
      button('Tải xuống', 'ghost', () => downloadOutput(job.outputKey, job.fileName)),
    );
  if (key === 'review' || key === 'failed')
    actions.append(button('Mở trong Canvas', 'ghost', () => openInCanvas(job), 'Sửa tay từng cảnh'));
  if (key === 'review')
    actions.append(
      button('Làm lại', 'ghost', () => redo(job), 'Bỏ phiên bản này và làm lại tập từ đầu'),
      button('Duyệt', 'primary', () => approve(job)),
    );
  if (key === 'failed')
    actions.append(button('Thử lại', 'primary', () => retry(job), 'Chạy tiếp từ bước cuối cùng đã xong'));
  if (key === 'queued') {
    const up = button('↑', 'ghost', () => move(items, index, -1), 'Chạy sớm hơn');
    const down = button('↓', 'ghost', () => move(items, index, 1), 'Chạy sau');
    up.disabled = index === 0;
    down.disabled = index === items.length - 1;
    up.setAttribute('aria-label', 'Chạy sớm hơn');
    down.setAttribute('aria-label', 'Chạy sau');
    actions.append(up, down);
  }
  if (key === 'active' && isStale(job, control))
    actions.append(
      button(
        'Xếp hàng lại',
        'primary',
        () => requeue(job).then(refresh),
        'Worker không còn phản hồi; đưa tập này trở lại hàng đợi',
      ),
    );
  if (key === 'queued' || key === 'failed') actions.append(button('Xoá', 'ghost', () => remove(job)));
  row.append(main, actions);
  return row;
}

function groupSection(group, items, control) {
  const section = el('section', `job-group job-group-${group.key}`);
  const head = el('div', 'job-group-head');
  head.append(el('h2', '', `${group.title} (${items.length})`));
  if (group.key === 'done')
    head.append(
      button('Tải tất cả', 'ghost', () => downloadApproved(items)),
      button(
        'Dọn danh sách',
        'ghost',
        () => clearApproved(items),
        'Bỏ các tập đã duyệt khỏi danh sách này; MP4 của chúng vẫn còn trong Studio',
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
  details.append(el('summary', '', 'Cài đặt hàng đợi'));
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
    field('Số worker', 'workers', { type: 'number', min: 1, max: MAX_WORKERS }, clamp(1, MAX_WORKERS)),
    field('Số lần thử mỗi tập', 'maxAttempts', { type: 'number', min: 1, max: 5 }, clamp(1, 5)),
    field(
      'Nghỉ giữa các lượt gửi Muse (giây)',
      'cooldownSec',
      { type: 'number', min: 0, max: 120 },
      clamp(0, 120),
    ),
    field('URL chat mới', 'museHomeUrl', { type: 'url' }, workerChatUrl),
  );
  return details;
}

function workerStrip(control) {
  const strip = el('ul', 'worker-strip');
  strip.setAttribute('aria-label', 'Danh sách worker');
  const count = Math.max(control.workers, production.workers.length);
  for (let id = 1; id <= count; id++) {
    const live = production.workers.find(item => item.id === String(id));
    const job = production.jobs.find(
      item => ['running', 'exporting'].includes(item.status) && workerLabel(item.workerId) === String(id),
    );
    const stale = job && isStale(job, control);
    const item = el(
      'li',
      `worker-chip ${!live ? 'is-off' : stale ? 'is-stale' : job ? 'is-busy' : 'is-idle'}`,
    );
    const text = !live
      ? 'Đã đóng'
      : stale
        ? 'Không phản hồi'
        : job
          ? job.title
          : control.paused
            ? 'Đã tạm dừng'
            : 'Đang chờ tập';
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
  titles.append(el('h1', '', 'Sản xuất'), el('p', '', summaryText(summary)));
  const actions = el('div', 'production-actions');
  if (control.paused)
    actions.append(
      button(
        control.reason ? 'Tiếp tục' : 'Bắt đầu',
        'primary',
        startQueue,
        'Mở các cửa sổ worker và sản xuất các tập đang xếp hàng',
      ),
    );
  else
    actions.append(
      button('Tạm dừng', 'ghost', pauseQueue, 'Làm xong các tập đang chạy rồi ngừng nhận tập mới'),
      button(
        'Dừng ngay',
        'danger',
        stopQueue,
        'Dừng ngay các tập đang chạy; chúng sẽ chạy tiếp từ bước cuối cùng đã xong',
      ),
    );
  actions.append(
    button('Đóng worker', 'ghost', closeWorkers, 'Đóng các tab worker và cửa sổ Muse của chúng'),
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
      el('h2', '', 'Hàng đợi đang trống'),
      el(
        'p',
        '',
        'Xếp hàng các tập từ Studio. Các tập chạy ở đây, mỗi worker một tập, và MP4 làm xong sẽ chờ bạn duyệt.',
      ),
      button('Đến Studio', 'primary', () => setView('studio')),
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
      isStale(job, control),
    ]),
  ]);
  if (signature === production.signature) return;
  if (document.activeElement?.matches('#production input')) return;
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
    setRunStatus(`Không đọc được hàng đợi sản xuất: ${error?.message || error}`, 'error'),
  );
}
