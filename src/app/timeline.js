import { state } from '../core/state.js';
import { uid } from '../core/node-defs.js';
import { nodeById, getIncoming, topoOrder } from '../core/graph.js';
import { $, setRunStatus } from './dom.js';
import { scheduleAutoSave, saveState } from './persistence.js';
import { createUndoSnapshot } from './undo.js';
import { render } from './render.js';

export function renderTimelineBody(node, body) {
  const edges = getIncoming(node.id).filter(e => e.targetPort.startsWith('clip'));
  const ordered = (node.data.clipOrder || []).filter(id =>
    state.nodes.some(n => n.id === id && n.type === 'generateVideo'),
  );
  for (const edge of edges) if (!ordered.includes(edge.source)) ordered.push(edge.source);
  for (const id of node.data.clipOrder || [])
    if (state.nodes.some(n => n.id === id && n.type === 'generateVideo') && !ordered.includes(id))
      ordered.push(id);
  node.data.clipOrder = ordered;
  syncTimelineDock();
  node._timelineEdges = edges;
  const bar = document.createElement('div');
  bar.className = 'timeline-toolbar';
  const count = document.createElement('span');
  count.textContent = `${ordered.length} clip`;
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'small-btn';
  play.textContent = '▶ Xem trước chuỗi cảnh';
  play.disabled = !ordered.some(id => nodeById(id)?.data?.asset?.url);
  play.onclick = () => playTimeline(node);
  bar.append(count, play);
  body.appendChild(bar);
  const track = document.createElement('div');
  track.className = 'timeline-track';
  if (!ordered.length) {
    const empty = document.createElement('div');
    empty.className = 'timeline-empty';
    empty.textContent = 'Thả node video vào đây hoặc nối chúng vào đầu vào clip';
    track.appendChild(empty);
  }
  ordered.forEach((id, index) => {
    const source = nodeById(id);
    if (!source) return;
    const clip = document.createElement('div');
    clip.className = 'timeline-clip';
    clip.draggable = true;
    clip.dataset.clip = id;
    clip.ondragstart = e => {
      e.dataTransfer.setData('text/plain', id);
      e.dataTransfer.effectAllowed = 'move';
    };
    clip.ondragover = e => {
      e.preventDefault();
    };
    clip.ondrop = e => {
      e.preventDefault();
      const moving =
          e.dataTransfer.getData('application/x-museta-video-node') || e.dataTransfer.getData('text/plain'),
        arr = [...node.data.clipOrder],
        from = arr.indexOf(moving),
        to = arr.indexOf(id);
      if (from >= 0 && to >= 0 && from !== to) {
        createUndoSnapshot('Sắp xếp lại clip trên Timeline');
        arr.splice(from, 1);
        arr.splice(to, 0, moving);
        node.data.clipOrder = arr;
        syncTimelineDock();
        render();
        saveState();
      }
    };
    const label = document.createElement('div');
    label.className = 'timeline-clip-head';
    label.textContent = `${String(index + 1).padStart(2, '0')} · ${source.data.asset?.name || 'Clip video'}`;
    const length = document.createElement('label');
    length.className = 'clip-duration';
    length.textContent = 'Phát (giây)';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '60';
    input.value = String(node.data.durations?.[id] || source.data.duration || 5);
    input.onchange = () => {
      node.data.durations = node.data.durations || {};
      node.data.durations[id] = Math.max(1, Math.min(60, Number(input.value) || 5));
      scheduleAutoSave();
    };
    length.appendChild(input);
    const status = document.createElement('span');
    status.className = `timeline-clip-state ${source.data.status || 'idle'}`;
    status.textContent = source.data.status || 'đang chờ';
    clip.append(label, length, status);
    track.appendChild(clip);
  });
  body.appendChild(track);
  body.appendChild(createTimelineDropZone(node));
}

export function createTimelineDropZone(node) {
  const zone = document.createElement('div');
  zone.className = 'timeline-inline-drop';
  zone.textContent = 'Thả node video vào đây để thêm vào timeline';
  zone.ondragover = event => {
    event.preventDefault();
    zone.classList.add('drag-over');
  };
  zone.ondragleave = () => zone.classList.remove('drag-over');
  zone.ondrop = event => {
    event.preventDefault();
    zone.classList.remove('drag-over');
    addTimelineClip(
      node,
      event.dataTransfer.getData('application/x-museta-video-node') ||
        event.dataTransfer.getData('text/plain'),
    );
  };
  return zone;
}

export function ensureDockTimeline() {
  let timeline = state.nodes.find(item => item.type === 'timeline');
  if (!timeline) {
    timeline = {
      id: uid('timeline'),
      type: 'timeline',
      x: 0,
      y: 0,
      data: { clipOrder: [], durations: {}, dockOnly: true },
    };
    state.nodes.push(timeline);
  }
  timeline.data = timeline.data || {};
  timeline.data.clipOrder = timeline.data.clipOrder || [];
  timeline.data.durations = timeline.data.durations || {};
  return timeline;
}

export function addTimelineClip(timeline, nodeId) {
  if (!nodeId || nodeById(nodeId)?.type !== 'generateVideo') {
    setRunStatus('Chỉ đầu ra của Generate Video mới thêm được vào timeline.', 'warn');
    return;
  }
  timeline = timeline || state.nodes.find(item => item.type === 'timeline') || null;
  if (timeline?.data?.clipOrder?.includes(nodeId)) return;
  createUndoSnapshot('Thêm video vào Timeline');
  timeline = timeline || ensureDockTimeline();
  timeline.data.clipOrder = timeline.data.clipOrder || [];
  if (!timeline.data.clipOrder.includes(nodeId)) timeline.data.clipOrder.push(nodeId);
  syncTimelineDock();
  render();
  saveState();
  setRunStatus('Đã thêm video vào timeline.', 'ok');
}

export function importAllVideosToTimeline() {
  const timelineBefore = state.nodes.find(item => item.type === 'timeline'),
    orderBefore = timelineBefore?.data?.clipOrder || [],
    existing = new Set(orderBefore),
    all = state.nodes.filter(item => item.type === 'generateVideo');
  const additions = all.filter(video => !existing.has(video.id));
  if (!additions.length) {
    setRunStatus(
      all.length
        ? 'Mọi node Generate Video đều đã có trên timeline.'
        : 'Không có node Generate Video nào để nhập.',
      'warn',
    );
    return;
  }
  createUndoSnapshot('Nhập video vào Timeline');
  const timeline = timelineBefore || ensureDockTimeline(),
    order = timeline.data.clipOrder,
    addIds = new Set(additions.map(video => video.id));
  order.push(...topoOrder().filter(id => addIds.has(id)));
  syncTimelineDock();
  render();
  saveState();
  if ($('#timelineDock').classList.contains('collapsed')) toggleTimeline();
  setRunStatus(
    `Đã nhập ${additions.length} node video vào timeline. Khi chạy, video sẽ được tạo theo thứ tự trên timeline.`,
    'ok',
  );
}

const DEFAULT_MUSIC_VOLUME = 0.35;
let musicPreview = null;

export function syncTimelineTransition(node = ensureDockTimeline()) {
  const transition = node.data.transition || { type: 'cut', duration: 0.5 };
  $('#timelineTransition').value = transition.type;
  $('#timelineTransitionDuration').value = String(transition.duration ?? 0.5);
  $('#timelineTransitionDuration').disabled = transition.type === 'cut';
}

export function setTimelineTransition({ type, duration }) {
  const node = ensureDockTimeline(),
    current = node.data.transition || { type: 'cut', duration: 0.5 };
  createUndoSnapshot('Đổi chuyển cảnh của timeline', { preserveRuntime: false });
  node.data.transition = {
    type: type ?? current.type,
    duration: Math.max(0.1, Math.min(2, Number(duration ?? current.duration) || 0.5)),
  };
  syncTimelineTransition(node);
  scheduleAutoSave();
}

export function syncTimelineSubtitles(node = ensureDockTimeline()) {
  $('#timelineSubtitles').checked = node.data.subtitles === 'bilingual';
}

export function setTimelineSubtitles(enabled) {
  const node = ensureDockTimeline();
  createUndoSnapshot(enabled ? 'Bật phụ đề song ngữ' : 'Tắt phụ đề song ngữ', { preserveRuntime: false });
  node.data.subtitles = enabled ? 'bilingual' : 'off';
  syncTimelineSubtitles(node);
  scheduleAutoSave();
}

export function syncTimelineClipAudio(node = ensureDockTimeline()) {
  $('#timelineClipAudio').value = ['mute', 'duck'].includes(node.data.clipAudio)
    ? node.data.clipAudio
    : 'keep';
}

export function setTimelineClipAudio(mode) {
  const node = ensureDockTimeline();
  createUndoSnapshot('Đổi âm thanh gốc của clip', { preserveRuntime: false });
  node.data.clipAudio = ['mute', 'duck'].includes(mode) ? mode : 'keep';
  syncTimelineClipAudio(node);
  scheduleAutoSave();
}

export function syncTimelineMusic(node = ensureDockTimeline()) {
  const music = node.data.music;
  $('#timelineMusicControls').classList.toggle('hidden', !music?.url);
  $('#timelineMusicBtn').textContent = music?.url ? '♪ Đổi nhạc' : '♪ Nhạc';
  $('#timelineMusicName').textContent = music?.name || '';
  $('#timelineMusicName').title = music?.name || '';
  $('#timelineMusicVolume').value = String(music?.volume ?? DEFAULT_MUSIC_VOLUME);
}

export function setTimelineMusic(file) {
  if (!file) return;
  if (!file.type.startsWith('audio/')) {
    setRunStatus('Hãy chọn một file âm thanh làm nhạc nền.', 'warn');
    return;
  }
  const node = ensureDockTimeline();
  createUndoSnapshot('Đặt nhạc nền', { preserveRuntime: false });
  node.data.music = {
    id: uid('music'),
    url: URL.createObjectURL(file),
    name: file.name,
    volume: node.data.music?.volume ?? DEFAULT_MUSIC_VOLUME,
  };
  syncTimelineMusic(node);
  saveState();
  setRunStatus(`Đã thêm nhạc nền: ${file.name}. Nhạc được trộn vào bản xem trước và bản xuất.`, 'ok');
}

export function setTimelineMusicVolume(value) {
  const node = ensureDockTimeline();
  if (!node.data.music) return;
  node.data.music = { ...node.data.music, volume: Math.max(0, Math.min(1, Number(value) || 0)) };
  if (musicPreview) musicPreview.volume = node.data.music.volume;
  scheduleAutoSave();
}

export function removeTimelineMusic() {
  const node = ensureDockTimeline();
  if (!node.data.music) return;
  createUndoSnapshot('Gỡ nhạc nền', { preserveRuntime: false });
  delete node.data.music;
  stopMusicPreview();
  syncTimelineMusic(node);
  saveState();
  setRunStatus('Đã gỡ nhạc nền.', 'ok');
}

function startMusicPreview(node, startTime) {
  stopMusicPreview();
  const music = node.data.music;
  if (!music?.url) return;
  musicPreview = new Audio(music.url);
  musicPreview.loop = true;
  musicPreview.volume = Math.max(0, Math.min(1, Number(music.volume ?? DEFAULT_MUSIC_VOLUME)));
  const seek = () => {
    if (Number.isFinite(musicPreview?.duration) && musicPreview.duration > 0)
      musicPreview.currentTime = startTime % musicPreview.duration;
  };
  musicPreview.addEventListener('loadedmetadata', seek, { once: true });
  musicPreview.play().catch(() => {});
}

function stopMusicPreview() {
  musicPreview?.pause();
  musicPreview = null;
}

export function syncTimelineDock() {
  const dock = $('#timelineDock'),
    track = $('#timelineTrack'),
    count = $('#timelineClipCount'),
    addButton = $('#timelineAddVideoBtn'),
    importAllButton = $('#timelineImportAllBtn'),
    outputMenu = $('#timelineOutputMenu'),
    node = ensureDockTimeline();
  dock.classList.remove('no-timeline');
  syncTimelineMusic(node);
  syncTimelineTransition(node);
  syncTimelineSubtitles(node);
  syncTimelineClipAudio(node);
  const allVideos = state.nodes.filter(item => item.type === 'generateVideo'),
    candidates = allVideos.filter(item => !(node.data.clipOrder || []).includes(item.id));
  addButton.disabled = !candidates.length;
  addButton.title = addButton.disabled ? 'Mọi đầu ra video đều đã có trên timeline' : 'Thêm một đầu ra video';
  importAllButton.disabled = !candidates.length;
  importAllButton.title = !allVideos.length
    ? 'Không có node Generate Video nào để nhập'
    : !candidates.length
      ? 'Mọi node Generate Video đều đã có trên timeline'
      : 'Nhập mọi node Generate Video';
  outputMenu.innerHTML = '';
  if (!candidates.length) {
    const empty = document.createElement('span');
    empty.textContent = 'Chưa có đầu ra video nào';
    outputMenu.appendChild(empty);
  }
  candidates.forEach((video, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.textContent = video.data.asset?.name || `Generate Video ${index + 1}`;
    option.onclick = () => {
      outputMenu.classList.add('hidden');
      addTimelineClip(node, video.id);
    };
    outputMenu.appendChild(option);
  });
  const clips = (node.data.clipOrder || [])
    .map(id => nodeById(id))
    .filter(item => item?.type === 'generateVideo');
  node.data.clipOrder = clips.map(item => item.id);
  count.textContent = `${clips.length} clip`;
  track.innerHTML = '';
  const pixelsPerSecond = 42,
    total = clips.reduce(
      (sum, clip) => sum + Number(node.data.durations?.[clip.id] || clip.data.duration || 5),
      0,
    );
  track.style.setProperty(
    '--timeline-total-width',
    `${Math.max(track.clientWidth, total * pixelsPerSecond)}px`,
  );
  const ruler = document.createElement('div');
  ruler.className = 'timeline-ruler';
  ruler.setAttribute('role', 'slider');
  ruler.setAttribute('aria-label', 'Vị trí phát trên timeline');
  ruler.setAttribute('aria-valuemin', '0');
  ruler.setAttribute('aria-valuemax', String(total));
  ruler.tabIndex = 0;
  ruler.style.width = `${Math.max(track.clientWidth, total * pixelsPerSecond)}px`;
  for (let sec = 0; sec <= Math.ceil(total); sec += 5) {
    const tick = document.createElement('span');
    tick.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    tick.style.flexBasis = `${5 * pixelsPerSecond}px`;
    ruler.appendChild(tick);
  }
  track.appendChild(ruler);
  const playhead = document.createElement('div');
  playhead.className = 'timeline-playhead';
  playhead.style.left = `${(state.timelinePreviewPosition || 0) * pixelsPerSecond}px`;
  playhead.style.height = `${Math.max(70, track.clientHeight - 8)}px`;
  playhead.setAttribute('aria-hidden', 'true');
  track.appendChild(playhead);
  let scrubbing = false;
  const updateScrub = e => {
    const rect = track.getBoundingClientRect(),
      time = Math.max(0, Math.min(total, (e.clientX - rect.left + track.scrollLeft) / pixelsPerSecond));
    state.timelinePreviewPosition = time;
    ruler.setAttribute('aria-valuenow', String(time.toFixed(2)));
    playhead.style.left = `${time * pixelsPerSecond}px`;
  };
  ruler.onpointerdown = e => {
    if (e.button !== 0) return;
    e.preventDefault();
    scrubbing = true;
    ruler.setPointerCapture(e.pointerId);
    updateScrub(e);
  };
  ruler.onpointermove = e => {
    if (scrubbing) updateScrub(e);
  };
  ruler.onpointerup = e => {
    if (!scrubbing) return;
    scrubbing = false;
    updateScrub(e);
    playTimeline(node, { startTime: state.timelinePreviewPosition });
  };
  ruler.onpointercancel = () => {
    scrubbing = false;
  };
  ruler.onkeydown = e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? total
          : Math.max(
              0,
              Math.min(total, (state.timelinePreviewPosition || 0) + (e.key === 'ArrowRight' ? 1 : -1)),
            );
    state.timelinePreviewPosition = next;
    playhead.style.left = `${next * pixelsPerSecond}px`;
    ruler.setAttribute('aria-valuenow', String(next));
    playTimeline(node, { startTime: next });
  };
  const lane = document.createElement('div');
  lane.className = 'timeline-lane';
  if (!clips.length) {
    const empty = document.createElement('div');
    empty.className = 'dock-empty';
    empty.textContent = 'Thả node Generate Video vào đây để dựng chuỗi cảnh';
    lane.appendChild(empty);
  }
  clips.forEach((clip, index) => {
    const duration = Number(node.data.durations?.[clip.id] || clip.data.duration || 5),
      item = document.createElement('div');
    item.className = `dock-clip${duration < 4 ? ' compact' : ''}`;
    item.style.width = `${duration * pixelsPerSecond}px`;
    item.style.minWidth = `${duration * pixelsPerSecond}px`;
    item.style.maxWidth = `${duration * pixelsPerSecond}px`;
    item.draggable = true;
    item.dataset.clip = clip.id;
    item.ondragstart = event => {
      event.dataTransfer.setData('application/x-museta-video-node', clip.id);
      event.dataTransfer.effectAllowed = 'move';
    };
    item.ondragover = event => event.preventDefault();
    item.ondrop = event => {
      event.preventDefault();
      const moving = event.dataTransfer.getData('application/x-museta-video-node'),
        from = node.data.clipOrder.indexOf(moving),
        to = node.data.clipOrder.indexOf(clip.id);
      if (from >= 0 && to >= 0 && from !== to) {
        createUndoSnapshot('Sắp xếp lại clip trên Timeline');
        node.data.clipOrder.splice(from, 1);
        node.data.clipOrder.splice(to, 0, moving);
        syncTimelineDock();
        render();
        saveState();
      } else if (moving && nodeById(moving)?.type === 'generateVideo') addTimelineClip(node, moving);
    };
    const thumb = document.createElement('div');
    thumb.className = 'dock-clip-thumb';
    if (clip.data.asset?.url) {
      if (clip.data.asset.kind === 'image') {
        const image = document.createElement('img');
        image.src = clip.data.asset.url;
        thumb.appendChild(image);
      } else {
        const video = document.createElement('video');
        video.src = clip.data.asset.url;
        video.muted = true;
        video.preload = 'metadata';
        thumb.appendChild(video);
      }
    } else thumb.textContent = '▶';
    const details = document.createElement('div');
    details.className = 'dock-clip-details';
    const title = document.createElement('span');
    title.textContent = `${String(index + 1).padStart(2, '0')} · ${clip.data.asset?.name || 'Video ' + (index + 1)}`;
    title.title = title.textContent;
    const length = document.createElement('label');
    length.textContent = 'Thời lượng';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '60';
    input.value = String(duration);
    input.onchange = () => {
      node.data.durations = node.data.durations || {};
      node.data.durations[clip.id] = Math.max(1, Math.min(60, Number(input.value) || 5));
      syncTimelineDock();
      render();
      saveState();
    };
    length.appendChild(input);
    details.append(title, length);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Gỡ clip';
    remove.onclick = () => {
      createUndoSnapshot('Gỡ clip khỏi Timeline');
      node.data.clipOrder = node.data.clipOrder.filter(id => id !== clip.id);
      syncTimelineDock();
      render();
      saveState();
    };
    item.append(thumb, details, remove);
    lane.appendChild(item);
  });
  track.appendChild(lane);
  dock.ondragover = event => {
    if (event.dataTransfer.types.includes('application/x-museta-video-node')) {
      event.preventDefault();
      dock.classList.add('drag-over');
      if (dock.classList.contains('collapsed')) toggleTimeline();
    }
  };
  dock.ondragleave = event => {
    if (!dock.contains(event.relatedTarget)) dock.classList.remove('drag-over');
  };
  dock.ondrop = event => {
    event.preventDefault();
    dock.classList.remove('drag-over');
    const id = event.dataTransfer.getData('application/x-museta-video-node');
    if (id) addTimelineClip(node, id);
  };
}

export function toggleTimelineOutputMenu() {
  if ($('#timelineAddVideoBtn').disabled) return;
  $('#timelineOutputMenu').classList.toggle('hidden');
}

export function toggleTimeline() {
  const dock = $('#timelineDock'),
    collapsed = dock.classList.toggle('collapsed'),
    button = $('#timelineToggleBtn');
  button.textContent = collapsed ? '▲' : '▼';
  button.title = collapsed ? 'Hiện timeline' : 'Ẩn timeline';
  button.setAttribute('aria-expanded', String(!collapsed));
}

export function closeTimelinePreview() {
  state.timelinePreviewToken++;
  clearTimeout(state.timelinePreviewTimer);
  cancelAnimationFrame(state.timelinePlayheadFrame);
  state.timelinePlayheadFrame = 0;
  for (const player of [$('#timelinePlayer'), $('#timelinePlayerNext')]) {
    player.pause();
    player.onended = null;
  }
  stopMusicPreview();
  $('#timelinePreviewPanel').classList.add('hidden');
}
export function visibleTimelineClipOrder(node) {
  const nodeTrack = document.querySelector(`.node[data-id="${CSS.escape(node.id)}"] .timeline-track`),
    dockTrack = $('#timelineTrack'),
    visualTrack = nodeTrack || dockTrack,
    selector = nodeTrack ? '.timeline-clip' : '.dock-clip',
    visibleOrder = [...visualTrack.querySelectorAll(selector)].map(item => item.dataset.clip).filter(Boolean);
  return visibleOrder.length ? visibleOrder : [...(node.data.clipOrder || [])];
}
export function playTimeline(node, { startTime = 0 } = {}) {
  const players = [$('#timelinePlayer'), $('#timelinePlayerNext')],
    panel = $('#timelinePreviewPanel'),
    clips = visibleTimelineClipOrder(node)
      .map(id => nodeById(id))
      .filter(n => n?.type === 'generateVideo' && n.data?.asset?.url);
  if (!clips.length) {
    setRunStatus('Hãy nối các clip video đã tạo xong vào timeline trước.', 'warn');
    return;
  }
  clearTimeout(state.timelinePreviewTimer);
  cancelAnimationFrame(state.timelinePlayheadFrame);
  const token = ++state.timelinePreviewToken;
  panel.classList.remove('hidden');
  const durationOf = clip => Math.max(1, Number(node.data.durations?.[clip.id] || clip.data.duration || 5)),
    total = clips.reduce((sum, clip) => sum + durationOf(clip), 0);
  let position = Math.max(0, Math.min(total, Number(startTime) || 0)),
    index = 0;
  while (index < clips.length - 1 && position >= durationOf(clips[index])) {
    position -= durationOf(clips[index]);
    index++;
  }
  let firstOffset = position,
    activeClipStart = Math.max(0, startTime - position),
    tickerStarted = false,
    active = players.findIndex(player => player.classList.contains('is-active'));
  if (active < 0) active = 0;
  state.timelinePreviewPosition = startTime;
  startMusicPreview(node, startTime);
  players.forEach(player => {
    player.pause();
    player.onended = null;
    player.muted = false;
    player.controls = player === players[active];
  });
  const waitForFrame = video =>
    new Promise(resolve => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(fallback);
        resolve();
      };
      const fallback = setTimeout(done, 1200);
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(done);
      else requestAnimationFrame(() => requestAnimationFrame(done));
    });
  const waitForData = video =>
    new Promise((resolve, reject) => {
      if (video.readyState >= 2) {
        resolve();
        return;
      }
      let timer = setTimeout(() => {
        cleanup();
        reject(new Error('Clip timeline tiếp theo không tải kịp.'));
      }, 15000);
      const ready = () => {
          cleanup();
          resolve();
        },
        failed = () => {
          cleanup();
          reject(new Error('Không tải được clip timeline tiếp theo.'));
        },
        cleanup = () => {
          clearTimeout(timer);
          video.removeEventListener('loadeddata', ready);
          video.removeEventListener('error', failed);
        };
      video.addEventListener('loadeddata', ready, { once: true });
      video.addEventListener('error', failed, { once: true });
    });
  const prepareClip = (clipIndex, video) => {
    const clip = clips[clipIndex];
    if (!clip) return Promise.resolve();
    if (video.dataset.preloadClip === clip.id && video.readyState >= 2) return Promise.resolve(video);
    video.pause();
    video.onended = null;
    video.preload = 'auto';
    video.dataset.preloadClip = clip.id;
    video.src = clip.data.asset.url;
    video.load();
    return waitForData(video).then(() => {
      if (video.dataset.preloadClip === clip.id) video.currentTime = 0;
      return video;
    });
  };
  const playNext = async () => {
    clearTimeout(state.timelinePreviewTimer);
    if (token !== state.timelinePreviewToken) return;
    if (index >= clips.length) {
      players[active].onended = null;
      players[active].pause();
      state.timelinePreviewPosition = total;
      const head = $('#timelineTrack .timeline-playhead');
      if (head) head.style.left = `${total * 42}px`;
      cancelAnimationFrame(state.timelinePlayheadFrame);
      stopMusicPreview();
      setRunStatus('Đã xem trước xong timeline.', 'ok');
      return;
    }
    const clipIndex = index,
      clip = clips[index++],
      nextIndex = 1 - active,
      next = players[nextIndex],
      previous = players[active];
    next.pause();
    next.onended = null;
    next.muted = false;
    next.controls = false;
    next.classList.remove('is-active', 'is-fading');
    const clipOffset = firstOffset;
    firstOffset = 0;
    let clipStart = 0;
    for (let i = 0; i < clipIndex; i++) clipStart += durationOf(clips[i]);
    activeClipStart = clipStart;
    try {
      await prepareClip(clipIndex, next);
      if (token !== state.timelinePreviewToken) return;
      next.currentTime = Math.min(clipOffset, Math.max(0, (next.duration || durationOf(clip)) - 0.05));
      activeClipStart = clipStart;
      await next.play();
      await waitForFrame(next);
    } catch (error) {
      if (token === state.timelinePreviewToken && next.readyState >= 2) {
        next.controls = true;
        next.classList.add('is-active');
        previous.controls = false;
        previous.classList.remove('is-active', 'is-fading');
        active = nextIndex;
        next.onended = () => {
          if (token === state.timelinePreviewToken) playNext();
        };
        setRunStatus(`Clip timeline đã sẵn sàng; bấm Phát để tiếp tục (${error.message})`, 'warn');
      } else if (token === state.timelinePreviewToken)
        setRunStatus(`Xem trước timeline đã tạm dừng: ${error.message}`, 'error');
      return;
    }
    if (token !== state.timelinePreviewToken) {
      next.pause();
      return;
    }
    next.controls = true;
    next.classList.add('is-active');
    previous.controls = false;
    previous.onended = null;
    previous.classList.remove('is-active');
    previous.classList.add('is-fading');
    active = nextIndex;
    setTimeout(() => {
      previous.classList.remove('is-fading');
      if (token === state.timelinePreviewToken) previous.pause();
    }, 180);
    if (!tickerStarted) {
      tickerStarted = true;
      const tick = () => {
        if (token !== state.timelinePreviewToken) return;
        const current = players[active],
          time = activeClipStart + (Number(current.currentTime) || 0);
        state.timelinePreviewPosition = time;
        const head = $('#timelineTrack .timeline-playhead');
        if (head) head.style.left = `${time * 42}px`;
        state.timelinePlayheadFrame = requestAnimationFrame(tick);
      };
      state.timelinePlayheadFrame = requestAnimationFrame(tick);
    }
    if (index < clips.length) prepareClip(index, previous).catch(() => {});
    const advance = () => {
      if (token !== state.timelinePreviewToken) return;
      clearTimeout(state.timelinePreviewTimer);
      next.onended = null;
      playNext();
    };
    next.onended = advance;
    state.timelinePreviewTimer = setTimeout(advance, Math.max(0.1, durationOf(clip) - clipOffset) * 1000);
    setRunStatus(`Timeline: cảnh quay ${index}/${clips.length}`, 'warn');
  };
  playNext();
}
