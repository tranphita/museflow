import { workflowFromScript } from '../core/film-graph.js';
import { parseCharacters, parseVoices, voiceFor } from '../core/scene-script.js';
import {
  SERIES_BIBLE,
  describeEpisode,
  episodeScript,
  groupCharacterFiles,
  isEpisodeFile,
  parseSeriesName,
} from '../core/series.js';
import { checkEpisode, checkSeries } from '../core/script-check.js';
import { $, el, setRunStatus } from './dom.js';
import { blobAsDataUrl } from './media.js';
import { importWorkflowFile } from './persistence.js';
import { createJob, episodeView, interleave } from '../core/jobs.js';
import { jobMediaPrefix } from '../core/checkpoint.js';
import { deleteMediaWithPrefix } from './media-store.js';
import {
  listSeries,
  saveSeries,
  deleteSeries,
  getOutput,
  deleteOutput,
  listJobs,
  putJobs,
  deleteJob,
} from './library-store.js';

const VIEW_KEY = 'museta-view';
const STATUS_TEXT = {
  new: 'Not run yet',
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Needs attention',
  stopped: 'Stopped',
  changed: 'Script changed',
};
const studio = { series: [], selectedId: null, jobs: [], jobSignature: '' };

const JOB_TEXT = {
  queued: 'Queued',
  running: 'Running',
  exporting: 'Exporting MP4',
  review: 'Ready to review',
  done: 'Done',
  failed: 'Needs attention',
};

const formatDuration = seconds =>
  `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
const formatElapsed = ms => formatDuration(Math.max(0, ms / 1000));
const selected = () => studio.series.find(series => series.id === studio.selectedId) || null;

export function setView(view) {
  document.body.dataset.view = view;
  for (const button of document.querySelectorAll('[data-view]'))
    button.setAttribute('aria-selected', String(button.dataset.view === view));
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {}
  if (view === 'studio') renderStudio();
  document.dispatchEvent(new CustomEvent('museta:view', { detail: view }));
}

function readText(file) {
  return file.text();
}

async function buildSeries(root, files) {
  const byName = name => files.find(file => file.relative === `${root}/${name}`);
  const bibleFile = byName(SERIES_BIBLE);
  const bible = bibleFile ? await readText(bibleFile.file) : '';
  const episodeFiles = files.filter(file => file.dir === root && isEpisodeFile(file.name));
  const characterFiles = files.filter(file => file.dir === `${root}/characters`).map(file => file.file);
  const characters = {};
  for (const [name, list] of Object.entries(groupCharacterFiles(characterFiles)))
    characters[name] = await Promise.all(list.map(file => blobAsDataUrl(file)));
  const episodes = [];
  for (const file of episodeFiles.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  )) {
    const text = await readText(file.file);
    episodes.push({
      id: file.name,
      fileName: file.name,
      text,
      ...describeEpisode(file.name, text, bible),
      status: 'new',
    });
  }
  const folder = root.split('/').pop();
  return {
    id: root,
    folder,
    name: parseSeriesName(bible) || folder,
    bible,
    characters,
    episodes,
    importedAt: Date.now(),
  };
}

function mergeSeries(previous, next) {
  if (!previous) return next;
  next.episodes = next.episodes.map(episode => {
    const old = previous.episodes.find(item => item.id === episode.id);
    if (!old) return episode;
    const carried = {
      status: old.status,
      lastRunAt: old.lastRunAt,
      runMs: old.runMs,
      error: old.error,
      outputKey: old.outputKey,
    };
    return { ...episode, ...carried, status: old.text === episode.text ? old.status : 'changed' };
  });
  return next;
}

async function importFolder(fileList) {
  const files = [...fileList]
    .map(file => {
      const relative = (file.webkitRelativePath || file.name).normalize('NFC');
      return {
        file,
        relative,
        name: file.name.normalize('NFC'),
        dir: relative.split('/').slice(0, -1).join('/'),
      };
    })
    .filter(file => !file.relative.includes('/workflows/'));
  const roots = [...new Set(files.filter(file => isEpisodeFile(file.name)).map(file => file.dir))];
  if (!roots.length) {
    setRunStatus('No episode files found. Choose a series folder that contains ep01-….txt files.', 'warn');
    return;
  }
  for (const root of roots) {
    const series = mergeSeries(
      studio.series.find(item => item.id === root),
      await buildSeries(root, files),
    );
    await saveSeries(series);
    studio.selectedId = root;
  }
  await loadLibrary();
  setRunStatus(`Imported ${roots.length} series into the Studio.`, 'ok');
}

async function loadLibrary() {
  studio.series = (await listSeries()).sort((a, b) => a.name.localeCompare(b.name));
  studio.jobs = await listJobs();
  if (!selected()) studio.selectedId = studio.series[0]?.id || null;
  renderStudio();
}

function latestJob(series, episode) {
  return (
    studio.jobs
      .filter(job => job.seriesId === series.id && job.episodeId === episode.id)
      .sort((a, b) => b.queuedAt - a.queuedAt)[0] || null
  );
}

function episodeState(series, episode) {
  const job = latestJob(series, episode);
  const view = episodeView(episode, job, series.importedAt);
  const fromJob = job && view.status === job.status;
  const progress = job?.progress?.total ? `, step ${job.progress.done}/${job.progress.total}` : '';
  const text =
    fromJob && job.status === 'running'
      ? `Running${progress}, worker ${job.workerId}`
      : (fromJob && JOB_TEXT[view.status]) || STATUS_TEXT[view.status] || view.status;
  return { ...view, job, text };
}

async function refreshJobs() {
  studio.jobs = await listJobs();
  const signature = JSON.stringify(
    studio.jobs.map(job => [job.id, job.status, job.progress, job.workerId, job.error]),
  );
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

async function openInCanvas(series, episode) {
  const workflow = workflowFromScript(episodeScript(series.bible, episode.text), {
    characterImages: series.characters,
  });
  const file = new File(
    [JSON.stringify({ format: 'museta-workflow', version: 1, workflow })],
    `${episode.id}.json`,
  );
  if (await importWorkflowFile(file)) setView('canvas');
}

async function removeSeries(series) {
  const jobs = studio.jobs.filter(job => job.seriesId === series.id);
  if (jobs.some(job => ['running', 'exporting'].includes(job.status)))
    return setRunStatus(
      'Wait until this series has no episode running, or press Stop now in Production.',
      'warn',
    );
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

function castStrip(series) {
  const voices = parseVoices(series.bible);
  const strip = el('ul', 'cast-strip');
  for (const character of parseCharacters(series.bible)) {
    const item = el('li', 'cast-member');
    const photo = (series.characters[character.name.normalize('NFC')] ||
      Object.entries(series.characters).find(
        ([key]) => key.toLowerCase() === character.name.toLowerCase(),
      )?.[1] ||
      [])[0];
    const avatar = el('div', 'cast-avatar');
    if (photo) {
      const image = el('img');
      image.src = photo;
      image.alt = '';
      avatar.appendChild(image);
    } else avatar.textContent = character.name[0];
    const text = el('div', 'cast-text');
    text.append(el('strong', '', character.name));
    const voice = voiceFor(voices, character.name);
    text.append(el('span', '', photo ? 'Reference photos' : 'Generated face'));
    if (voice) text.append(el('span', 'cast-voice', `Voice ${voice.replace(/^VIENEU_CLONE_/, '')}`));
    item.append(avatar, text);
    strip.appendChild(item);
  }
  return strip;
}

function issueToggle(row, issues) {
  const errors = issues.filter(issue => issue.level === 'error').length;
  const toggle = el(
    'button',
    `check-toggle ${errors ? 'has-errors' : 'has-warnings'}`,
    errors
      ? `${errors} problem${errors === 1 ? '' : 's'}`
      : `${issues.length} note${issues.length === 1 ? '' : 's'}`,
  );
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.onclick = () => {
    const open = row.classList.toggle('show-checks');
    toggle.setAttribute('aria-expanded', String(open));
  };
  return toggle;
}

function issueList(issues) {
  const list = el('ul', 'check-list');
  for (const issue of issues) {
    const item = el('li', `check-${issue.level}`);
    if (issue.scene) item.appendChild(el('strong', '', `Scene ${issue.scene}`));
    item.appendChild(el('span', '', issue.message));
    list.appendChild(item);
  }
  return list;
}

function seriesNotes(series) {
  const notes = checkSeries(series.bible, { photoNames: Object.keys(series.characters) });
  if (!notes.length) return document.createDocumentFragment();
  const box = el('div', 'series-notes');
  box.append(el('p', '', 'Before you run this series'), issueList(notes));
  return box;
}

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
  queue.title = current.open
    ? 'This episode is already in the production queue'
    : 'Add this episode to the production queue';
  queue.onclick = () => enqueue([{ series, episode }]);
  actions.append(open, queue);
  row.append(number, main, status, actions);
  return row;
}

function renderSeriesList() {
  const list = $('#studioSeriesList');
  list.replaceChildren(
    ...studio.series.map(series => {
      const item = el('li');
      const button = el('button', `series-link${series.id === studio.selectedId ? ' is-selected' : ''}`);
      button.type = 'button';
      const done = series.episodes.filter(episode => episodeState(series, episode).status === 'done').length;
      button.append(
        el('span', 'series-link-name', series.name),
        el('span', 'series-link-count', `${done}/${series.episodes.length}`),
      );
      button.title = `${done} of ${series.episodes.length} episodes done`;
      button.onclick = () => {
        studio.selectedId = series.id;
        renderStudio();
      };
      item.appendChild(button);
      return item;
    }),
  );
}

function renderEmpty(main) {
  const empty = el('div', 'studio-empty');
  empty.append(
    el('h1', '', 'Bring in your first series'),
    el(
      'p',
      '',
      'Choose a series folder. Museta reads _series.txt for the style, cast and voices, every ep01-….txt as an episode, and photos in characters/ as the cast faces.',
    ),
  );
  const button = el('button', 'primary', 'Import series folder');
  button.type = 'button';
  button.onclick = () => $('#studioFolderInput').click();
  empty.appendChild(button);
  main.replaceChildren(empty);
}

export function renderStudio() {
  if (!$('#studio')) return;
  renderSeriesList();
  const main = $('#studioMain'),
    series = selected();
  if (!series) return renderEmpty(main);
  const header = el('header', 'studio-header');
  const titles = el('div', 'studio-titles');
  titles.append(
    el('h1', '', series.name),
    el('p', '', `${series.episodes.length} episodes from the “${series.folder}” folder`),
  );
  const actions = el('div', 'studio-actions');
  const remaining = unfinished(series);
  const queueAll = el(
    'button',
    'run-all',
    remaining.length === series.episodes.length
      ? 'Queue all episodes'
      : `Queue ${remaining.length} remaining`,
  );
  queueAll.type = 'button';
  queueAll.disabled = !remaining.length;
  queueAll.onclick = () => enqueue(remaining);
  actions.appendChild(queueAll);
  const refresh = el('button', 'ghost', 'Update from folder');
  refresh.type = 'button';
  refresh.title = 'Choose the same folder again to load edited scripts and photos';
  refresh.onclick = () => $('#studioFolderInput').click();
  const remove = el('button', 'ghost', 'Remove');
  remove.type = 'button';
  remove.onclick = () => removeSeries(series);
  actions.append(refresh, remove);
  header.append(titles, actions);
  const list = el('ol', 'episode-list');
  list.setAttribute('aria-label', 'Episodes');
  list.append(...series.episodes.map(episode => episodeRow(series, episode)));
  main.replaceChildren(header, castStrip(series), seriesNotes(series), list);
}

function initAddNodeMenu() {
  const menu = $('#addNodeMenu'),
    toggle = $('#addNodeBtn');
  const close = () => {
    menu.classList.add('hidden');
    toggle.setAttribute('aria-expanded', 'false');
  };
  toggle.onclick = event => {
    event.stopPropagation();
    const open = menu.classList.toggle('hidden') === false;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      const rect = toggle.getBoundingClientRect();
      menu.style.left = `${Math.min(rect.left, innerWidth - 240)}px`;
      menu.style.top = `${rect.bottom + 6}px`;
    }
  };
  menu.addEventListener('click', event => {
    if (event.target.closest('[data-add]')) close();
  });
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest('.add-node')) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') close();
  });
}

export async function initStudio() {
  initAddNodeMenu();
  $('#studioImportBtn').onclick = () => $('#studioFolderInput').click();
  $('#studioFolderInput').onchange = async event => {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    if (files?.length)
      await importFolder(files).catch(error => setRunStatus(error?.message || String(error), 'error'));
  };
  for (const button of document.querySelectorAll('[data-view]'))
    button.onclick = () => setView(button.dataset.view);
  $('#studioPlayerClose').onclick = () => {
    $('#studioPlayer').pause();
    $('#studioPlayerModal').classList.add('hidden');
  };
  let view = 'studio';
  try {
    view = localStorage.getItem(VIEW_KEY) || 'studio';
  } catch {}
  setView(view);
  await loadLibrary().catch(error =>
    setRunStatus(`Could not open the Studio library: ${error?.message || error}`, 'error'),
  );
  $('#studioQueueAllBtn').onclick = () => enqueue(studio.series.flatMap(unfinished));
  setInterval(() => refreshJobs().catch(() => {}), 3000);
}
