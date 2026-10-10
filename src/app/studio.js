import { state } from '../core/state.js';
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
import { $, setRunStatus } from './dom.js';
import { blobAsDataUrl } from './media.js';
import { importWorkflowFile } from './persistence.js';
import { executeWorkflow, stopGeneration } from './runner.js';
import { exportTimelineVideo } from './timeline-export.js';
import {
  listSeries,
  saveSeries,
  deleteSeries,
  saveOutput,
  getOutput,
  deleteOutput,
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
const studio = { series: [], selectedId: null, running: null, stopRequested: false, queue: false };

const formatDuration = seconds =>
  `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
const formatElapsed = ms => formatDuration(Math.max(0, ms / 1000));
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const selected = () => studio.series.find(series => series.id === studio.selectedId) || null;

export function setView(view) {
  document.body.dataset.view = view;
  for (const button of document.querySelectorAll('[data-view]'))
    button.setAttribute('aria-selected', String(button.dataset.view === view));
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {}
  if (view === 'studio') renderStudio();
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
  if (!selected()) studio.selectedId = studio.series[0]?.id || null;
  renderStudio();
}

async function persist(series) {
  await saveSeries(series);
  renderStudio();
}

function runOutcome(previousRun) {
  const run = state.run;
  if (!run || run === previousRun)
    return { status: 'failed', error: $('#runStatus').textContent || 'The episode did not start.' };
  if (run.outcome === 'stopped') return { status: 'stopped', error: '' };
  if (run.outcome === 'error')
    return { status: 'failed', error: run.message || 'The episode stopped on an error.' };
  const failed = run.steps.find(step => step.status === 'error');
  return failed
    ? { status: 'failed', error: failed.error || 'A step failed.' }
    : { status: 'done', error: '' };
}

async function runEpisode(series, episode) {
  const startedAt = Date.now();
  studio.running = { seriesId: series.id, episodeId: episode.id, startedAt };
  episode.status = 'running';
  episode.error = '';
  await persist(series);
  const workflow = workflowFromScript(episodeScript(series.bible, episode.text), {
    characterImages: series.characters,
  });
  const file = new File(
    [JSON.stringify({ format: 'museta-workflow', version: 1, workflow })],
    `${episode.id}.json`,
    {
      type: 'application/json',
    },
  );
  try {
    if (!(await importWorkflowFile(file, { confirm: false })))
      throw new Error('Could not open this episode.');
    const previousRun = state.run;
    await executeWorkflow();
    const outcome = runOutcome(previousRun);
    episode.status = outcome.status;
    episode.error = outcome.error;
    if (outcome.status !== 'stopped' && !studio.stopRequested) {
      const exported = await exportTimelineVideo({ format: 'mp4', download: false });
      if (exported && state.timelineExportUrl) {
        const key = `${series.id}/${episode.id}`;
        await saveOutput(key, await (await fetch(state.timelineExportUrl)).blob());
        episode.outputKey = key;
      } else if (outcome.status === 'done') {
        episode.status = 'failed';
        episode.error = 'The episode ran but the MP4 could not be exported.';
      }
    }
  } catch (error) {
    episode.status = 'failed';
    episode.error = error?.message || String(error);
  } finally {
    episode.lastRunAt = Date.now();
    episode.runMs = Date.now() - startedAt;
    studio.running = null;
    await persist(series);
  }
}

async function runEpisodes(series, episodes) {
  if (state.isRunning || studio.running) {
    setRunStatus('Wait for the current run to finish first.', 'warn');
    return;
  }
  studio.stopRequested = false;
  studio.queue = episodes.length > 1;
  for (const episode of episodes) episode.status = episode === episodes[0] ? episode.status : 'queued';
  await persist(series);
  const ticker = setInterval(renderRunningRow, 1000);
  try {
    for (const episode of episodes) {
      if (studio.stopRequested) break;
      await runEpisode(series, episode);
      if (episode.status === 'stopped') break;
    }
  } finally {
    clearInterval(ticker);
    for (const episode of series.episodes) if (episode.status === 'queued') episode.status = 'new';
    studio.queue = false;
    await persist(series);
    const done = episodes.filter(episode => episode.status === 'done').length;
    setRunStatus(
      `${done} of ${episodes.length} episode${episodes.length === 1 ? '' : 's'} finished.`,
      done === episodes.length ? 'ok' : 'warn',
    );
  }
}

function stopStudio() {
  studio.stopRequested = true;
  if (state.isRunning) stopGeneration(state.activeGenerationId);
  state.generationAbortController?.abort();
}

async function downloadOutput(series, episode) {
  const blob = await getOutput(episode.outputKey);
  if (!blob) {
    setRunStatus('This MP4 is no longer in the library. Run the episode again.', 'warn');
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${series.name} - Tap ${String(episode.number).padStart(2, '0')} - ${episode.title}.mp4`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function playOutput(episode) {
  const blob = await getOutput(episode.outputKey);
  if (!blob) return;
  const player = $('#studioPlayer');
  if (player.src) URL.revokeObjectURL(player.src);
  player.src = URL.createObjectURL(blob);
  $('#studioPlayerTitle').textContent = `Episode ${episode.number}: ${episode.title}`;
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
  if (
    !window.confirm(
      `Remove “${series.name}” and its exported MP4s from the Studio? Files on your computer are not touched.`,
    )
  )
    return;
  for (const episode of series.episodes)
    if (episode.outputKey) await deleteOutput(episode.outputKey).catch(() => {});
  await deleteSeries(series.id);
  studio.selectedId = null;
  await loadLibrary();
}

function sceneGroups() {
  const groups = new Map();
  for (const step of state.run?.steps || []) {
    const scene = /Scene (\d+)/.exec(step.label)?.[1];
    const key = scene ? `Scene ${scene}` : 'Cast';
    if (!groups.has(key))
      groups.set(key, { label: scene ? scene : 'Cast', total: 0, done: 0, failed: false, active: false });
    const group = groups.get(key);
    group.total++;
    if (['done', 'kept', 'skipped', 'error', 'stopped'].includes(step.status)) group.done++;
    if (step.status === 'error') group.failed = true;
    if (step.status === 'running') group.active = true;
  }
  return [...groups.values()].sort((a, b) =>
    a.label === 'Cast' ? -1 : b.label === 'Cast' ? 1 : Number(a.label) - Number(b.label),
  );
}

function filmStrip() {
  const strip = el('div', 'film-strip');
  strip.setAttribute('aria-hidden', 'true');
  for (const group of sceneGroups()) {
    const frame = el(
      'div',
      `film-frame${group.active ? ' is-active' : ''}${group.failed ? ' is-failed' : ''}`,
    );
    const fill = el('span', 'film-frame-fill');
    fill.style.width = `${group.total ? (group.done / group.total) * 100 : 0}%`;
    frame.append(fill, el('span', 'film-frame-label', group.label));
    strip.appendChild(frame);
  }
  return strip;
}

function renderRunningRow() {
  const row = document.querySelector('.episode-row.is-running');
  if (!row || !studio.running) return;
  row.querySelector('.film-strip')?.replaceWith(filmStrip());
  const current = state.run?.steps.find(step => step.status === 'running');
  const detail = row.querySelector('.episode-live');
  if (detail)
    detail.textContent = `${formatElapsed(Date.now() - studio.running.startedAt)} elapsed${current ? `, now on ${current.label}` : ''}`;
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
  const isRunning = studio.running?.episodeId === episode.id && studio.running?.seriesId === series.id;
  const row = el('li', `episode-row status-${episode.status}${isRunning ? ' is-running' : ''}`);
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
  const blocking = issues.filter(issue => issue.level === 'error');
  if (issues.length) facts.appendChild(issueToggle(row, issues));
  else facts.appendChild(el('span', 'check-ok', 'Script checks passed'));
  main.appendChild(facts);
  if (issues.length) main.appendChild(issueList(issues));
  if (isRunning) {
    main.append(filmStrip(), el('p', 'episode-live', 'Starting…'));
  } else if (episode.error && ['failed', 'stopped'].includes(episode.status))
    main.appendChild(el('p', 'episode-error', episode.error));
  const status = el('div', 'episode-status');
  status.append(el('span', 'status-dot'), el('span', '', STATUS_TEXT[episode.status] || episode.status));
  if (episode.lastRunAt && !isRunning)
    status.append(
      el(
        'small',
        '',
        `${new Date(episode.lastRunAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}, took ${formatElapsed(episode.runMs || 0)}`,
      ),
    );
  const actions = el('div', 'episode-actions');
  if (episode.outputKey && !isRunning) {
    const play = el('button', 'ghost', 'Play');
    play.type = 'button';
    play.onclick = () => playOutput(episode);
    const download = el('button', 'ghost', 'Download MP4');
    download.type = 'button';
    download.onclick = () => downloadOutput(series, episode);
    actions.append(play, download);
  }
  const open = el('button', 'ghost', 'Open in canvas');
  open.type = 'button';
  open.disabled = Boolean(studio.running);
  open.onclick = () => openInCanvas(series, episode);
  const run = el(
    'button',
    isRunning ? 'danger' : 'run-one',
    isRunning ? 'Stop' : episode.outputKey ? 'Run again' : 'Run',
  );
  run.type = 'button';
  run.disabled = Boolean(studio.running) && !isRunning;
  run.onclick = () => {
    if (isRunning) return stopStudio();
    if (
      blocking.length &&
      !window.confirm(
        `Episode ${episode.number} has ${blocking.length} script problem${blocking.length === 1 ? '' : 's'} that will likely make Muse get it wrong. Run anyway?`,
      )
    )
      return;
    runEpisodes(series, [episode]);
  };
  actions.append(open, run);
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
      const done = series.episodes.filter(episode => episode.status === 'done').length;
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
  const pending = series.episodes.filter(episode => episode.status !== 'done');
  if (studio.running && studio.running.seriesId === series.id) {
    const stop = el('button', 'danger', studio.queue ? 'Stop queue' : 'Stop');
    stop.type = 'button';
    stop.onclick = stopStudio;
    actions.appendChild(stop);
  } else {
    const runAll = el(
      'button',
      'run-all',
      pending.length === series.episodes.length ? 'Run all episodes' : `Run ${pending.length} remaining`,
    );
    runAll.type = 'button';
    runAll.disabled = !pending.length || Boolean(studio.running);
    runAll.onclick = () => runEpisodes(series, pending);
    actions.appendChild(runAll);
  }
  const refresh = el('button', 'ghost', 'Update from folder');
  refresh.type = 'button';
  refresh.title = 'Choose the same folder again to load edited scripts and photos';
  refresh.disabled = Boolean(studio.running);
  refresh.onclick = () => $('#studioFolderInput').click();
  const remove = el('button', 'ghost', 'Remove');
  remove.type = 'button';
  remove.disabled = Boolean(studio.running);
  remove.onclick = () => removeSeries(series);
  actions.append(refresh, remove);
  header.append(titles, actions);
  const list = el('ol', 'episode-list');
  list.setAttribute('aria-label', 'Episodes');
  list.append(...series.episodes.map(episode => episodeRow(series, episode)));
  main.replaceChildren(header, castStrip(series), seriesNotes(series), list);
  renderRunningRow();
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
}
