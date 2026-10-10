import { state } from '../core/state.js';
import { nodeDefs, isMultiInput, DEFAULT_VOICE_ID } from '../core/node-defs.js';
import { nodeById, getIncoming, sourceFor, portCompatible, duplicateNodesForDrag } from '../core/graph.js';
import { clampDimension } from '../core/media-math.js';
import { restoreGeneration, removeGeneration } from '../core/history.js';
import { $, canvas, edgesSvg, setRunStatus } from './dom.js';
import { drawResized } from './media.js';
import { scheduleAutoSave, saveState } from './persistence.js';
import { createUndoSnapshot, trackUndoEdit } from './undo.js';
import { removeNode, selectNode } from './editor.js';
import { connect, startWire, startWireFromInput } from './connections.js';
import { applyCanvasTransform } from './viewport.js';
import { renderTimelineBody, ensureDockTimeline, addTimelineClip, syncTimelineDock } from './timeline.js';
import { executeGenerationNode, runSingleNode, runVoiceoverNode, voiceoverText } from './runner.js';

export function renderNode(n) {
  const el = document.createElement('section');
  el.className = `node ${['generateImage', 'generateVideo'].includes(n.type) ? 'generate' : ''} ${n.type === 'timeline' ? 'timeline-node' : ''} ${state.selectedNodeIds.includes(n.id) || state.selectedNodeId === n.id ? 'selected' : ''} ${n.data.status === 'running' ? 'is-running' : ''}`;
  el.dataset.id = n.id;
  el.style.left = `${n.x}px`;
  el.style.top = `${n.y}px`;
  const head = document.createElement('div');
  head.className = 'node-header';
  const title = document.createElement('span');
  title.className = 'node-title';
  title.textContent =
    n.data.customName || `${nodeDefs[n.type].title}${n.data.sceneLabel ? ` · ${n.data.sceneLabel}` : ''}`;
  title.title = title.textContent;
  const close = document.createElement('span');
  close.className = 'node-close';
  close.title = 'Xoá';
  close.textContent = '×';
  head.append(title, close);
  head.querySelector('.node-close').onclick = e => {
    e.stopPropagation();
    removeNode(n.id);
  };
  setupDrag(head, n, el);
  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'node-body';

  if (['prompt', 'negativePrompt', 'textAppend'].includes(n.type)) {
    const ta = document.createElement('textarea');
    ta.value = n.data.text || '';
    ta.oninput = () => (n.data.text = ta.value);
    body.appendChild(ta);
    if (n.type === 'negativePrompt') {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = 'Nối vào đầu vào negative của node ảnh hoặc video.';
      body.appendChild(hint);
    }
    if (n.type === 'textAppend') {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = 'Nối thêm đoạn văn bản này vào sau prompt đầu vào.';
      body.appendChild(hint);
    }
  }

  if (n.type === 'textConcat') {
    const separator = document.createElement('input');
    separator.value = n.data.separator ?? ', ';
    separator.placeholder = 'Dấu phân cách';
    separator.oninput = () => (n.data.separator = separator.value);
    body.append('Nối các văn bản đầu vào bằng:', separator);
  }

  if (n.type === 'imageInput') {
    if (n.data.localDataUrl) {
      const img = document.createElement('img');
      img.src = n.data.localDataUrl;
      body.appendChild(img);
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Chưa chọn ảnh';
      body.appendChild(empty);
    }
    const label = document.createElement('label');
    label.className = 'small-btn';
    label.textContent = 'Chọn ảnh';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        n.data.localDataUrl = String(r.result || '');
        render();
      };
      r.readAsDataURL(f);
    };
    label.appendChild(input);
    body.appendChild(label);
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Nối ảnh này vào Generate Image → tham chiếu.';
    body.appendChild(hint);
  }

  if (n.type === 'references') {
    const incoming = (nodeDefs.references.inputs || []).reduce(
        (count, input) => count + getIncoming(n.id, input.id).length,
        0,
      ),
      badge = document.createElement('span');
    badge.className = 'ref-badge';
    badge.textContent = `Đã nối ${incoming} nguồn ảnh`;
    body.appendChild(badge);
    const list = document.createElement('div');
    list.className = 'references-input-list';
    (nodeDefs.references.inputs || []).forEach(input => {
      const row = document.createElement('div');
      row.textContent = `${input.label} · nối nguồn ảnh`;
      list.appendChild(row);
    });
    body.appendChild(list);
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Mọi ảnh đã nối sẽ được gửi tới mọi node Generate Image và Generate Video đang nối.';
    body.appendChild(hint);
  }

  if (n.type === 'generateImage') {
    const controls = document.createElement('div');
    controls.className = 'gen-controls';
    const size = document.createElement('select');
    [
      ['1:1', 'Vuông'],
      ['16:9', 'Ngang 16:9'],
      ['9:16', 'Dọc 9:16'],
      ['4:3', 'Ngang 4:3'],
      ['3:4', 'Dọc 3:4'],
    ].forEach(([v, label]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      size.appendChild(o);
    });
    size.value = ['1:1', '16:9', '9:16', '4:3', '3:4'].includes(n.data.size) ? n.data.size : '1:1';
    size.onchange = () => (n.data.size = size.value);
    const model = document.createElement('input');
    model.value = n.data.model || 'muse-image';
    model.placeholder = 'muse-image';
    model.oninput = () => (n.data.model = model.value);
    controls.append(size, model);
    body.appendChild(controls);
    const st = document.createElement('div');
    st.className = `status ${n.data.status || 'idle'}`;
    st.textContent = nodeStatusText(n.data);
    body.appendChild(st);
    if (n.data.asset?.width && n.data.asset?.height) {
      const dimensions = document.createElement('div');
      dimensions.className = `hint ${n.data.asset.sizeMismatch ? 'error' : ''}`;
      dimensions.textContent = `Yêu cầu ${n.data.asset.requestedSize || n.data.size} · thực tế ${n.data.asset.width} × ${n.data.asset.height}${n.data.asset.sizeMismatch ? ' (Muse trả về tỉ lệ khác)' : ''}`;
      body.appendChild(dimensions);
    }
    if (n.data.asset?.url) {
      const a = document.createElement('a');
      a.href = n.data.asset.url;
      a.target = '_blank';
      a.className = 'image-link';
      const img = document.createElement('img');
      img.src = n.data.asset.url;
      a.appendChild(img);
      body.appendChild(a);
    }
    const promptCount = getIncoming(n.id, 'prompt').length;
    if (promptCount > 1) {
      const b = document.createElement('span');
      b.className = 'ref-badge';
      b.textContent = `Đã gộp ${promptCount} nguồn prompt`;
      body.appendChild(b);
    }
    const referenceCount = getIncoming(n.id, 'reference').length;
    if (referenceCount) {
      const b = document.createElement('span');
      b.className = 'ref-badge';
      b.textContent = `Đã nối ${referenceCount} ảnh tham chiếu`;
      body.appendChild(b);
    }
    body.appendChild(createHistoryStrip(n));
    body.appendChild(createNodeRunActions(n));
  }

  if (n.type === 'generateVideo') {
    const controls = document.createElement('div');
    controls.className = 'gen-controls video-controls';
    const ratio = document.createElement('select');
    [
      ['16:9', 'Ngang 16:9'],
      ['9:16', 'Dọc 9:16'],
      ['1:1', 'Vuông'],
    ].forEach(([v, label]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      ratio.appendChild(o);
    });
    ratio.value = ['16:9', '9:16', '1:1'].includes(n.data.size) ? n.data.size : '16:9';
    ratio.onchange = () => (n.data.size = ratio.value);
    const duration = document.createElement('select');
    [5, 6, 8, 10].forEach(v => {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = `${v}s`;
      duration.appendChild(o);
    });
    duration.value = String(n.data.duration || 5);
    duration.onchange = () => (n.data.duration = Number(duration.value));
    controls.append(ratio, duration);
    body.appendChild(controls);
    const continuityLabel = document.createElement('label');
    continuityLabel.className = 'continuity-toggle';
    continuityLabel.htmlFor = `continuity-${n.id}`;
    continuityLabel.onpointerdown = event => event.stopPropagation();
    const continuity = document.createElement('input');
    continuity.id = `continuity-${n.id}`;
    continuity.type = 'checkbox';
    continuity.checked = Boolean(n.data.continuity);
    continuity.onchange = () => {
      n.data.continuity = continuity.checked;
      scheduleAutoSave();
    };
    continuityLabel.append(
      continuity,
      document.createTextNode('Dùng khung hình cuối của clip trước làm tham chiếu mở đầu'),
    );
    body.appendChild(continuityLabel);
    if (n.data.endFrame?.url) {
      const frame = document.createElement('img');
      frame.className = 'end-frame-thumb';
      frame.src = n.data.endFrame.url;
      frame.alt = 'Khung hình cuối đã trích để nối liền cảnh';
      frame.title = 'Khung hình cuối của video · nối “khung cuối” vào tham chiếu của video tiếp theo';
      body.appendChild(frame);
    }
    const status = document.createElement('div');
    status.className = `status ${n.data.status || 'idle'}`;
    status.textContent = nodeStatusText(n.data);
    body.appendChild(status);
    if (n.data.asset?.width && n.data.asset?.height) {
      const dimensions = document.createElement('div');
      dimensions.className = `hint ${n.data.asset.sizeMismatch ? 'error' : ''}`;
      dimensions.textContent = `Yêu cầu ${n.data.asset.requestedSize || n.data.size} · thực tế ${n.data.asset.width} × ${n.data.asset.height}${n.data.asset.sizeMismatch ? ' (Muse trả về tỉ lệ khác)' : ''}`;
      body.appendChild(dimensions);
    }
    if (n.data.asset?.url) {
      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.src = n.data.asset.url;
      body.appendChild(video);
    }
    const timelineDrag = document.createElement('button');
    timelineDrag.type = 'button';
    timelineDrag.className = 'video-timeline-drag';
    timelineDrag.draggable = true;
    timelineDrag.innerHTML = '<span aria-hidden="true">⠿</span> Kéo kết quả vào Timeline';
    timelineDrag.title = 'Kéo kết quả này vào timeline';
    timelineDrag.ondragstart = event => {
      event.dataTransfer.setData('application/x-museta-video-node', n.id);
      event.dataTransfer.setData('text/plain', n.id);
      event.dataTransfer.effectAllowed = 'copy';
    };
    timelineDrag.onclick = event => {
      event.stopPropagation();
      addTimelineClip(ensureDockTimeline(), n.id);
    };
    body.appendChild(timelineDrag);
    body.appendChild(createHistoryStrip(n));
    body.appendChild(createNodeRunActions(n));
  }
  if (n.type === 'timeline') renderTimelineBody(n, body);
  if (n.type === 'voiceover') renderVoiceoverBody(n, body);

  if (n.type === 'imageResize') {
    const incoming = sourceFor(getIncoming(n.id, 'image')[0]);
    const imageUrl = incoming?.data?.localDataUrl || incoming?.data?.asset?.url || '';
    const width = document.createElement('input');
    width.type = 'number';
    width.min = '1';
    width.max = '4096';
    width.value = n.data.width || 1024;
    width.title = 'Chiều rộng';
    width.oninput = () => (n.data.width = clampDimension(width.value));
    const height = document.createElement('input');
    height.type = 'number';
    height.min = '1';
    height.max = '4096';
    height.value = n.data.height || 1024;
    height.title = 'Chiều cao';
    height.oninput = () => (n.data.height = clampDimension(height.value));
    const fit = document.createElement('select');
    [
      ['cover', 'Cắt cho đầy khung'],
      ['contain', 'Vừa trong khung'],
      ['stretch', 'Kéo giãn'],
    ].forEach(([v, label]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      fit.appendChild(o);
    });
    fit.value = n.data.fit || 'cover';
    fit.onchange = () => (n.data.fit = fit.value);
    body.append(width, height, fit);
    const out = document.createElement('canvas');
    out.className = 'resize-preview';
    if (imageUrl) {
      const image = new Image();
      image.onload = () => drawResized(image, out, n.data);
      image.src = imageUrl;
    }
    body.appendChild(out);
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'small-btn';
    download.textContent = 'Tải xuống ảnh đã đổi cỡ';
    download.disabled = !imageUrl;
    download.onclick = () => {
      out.toBlob(blob => {
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `museta-${n.data.width}x${n.data.height}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      });
    };
    body.appendChild(download);
  }

  if (n.type === 'preview') {
    if (n.data.asset?.url) {
      if (n.data.asset.kind === 'video') {
        const video = document.createElement('video');
        video.controls = true;
        video.src = n.data.asset.url;
        body.appendChild(video);
      } else {
        const a = document.createElement('a');
        a.href = n.data.asset.url;
        a.target = '_blank';
        const img = document.createElement('img');
        img.src = n.data.asset.url;
        a.appendChild(img);
        body.appendChild(a);
      }
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty preview-empty';
      empty.textContent = 'Chạy workflow';
      body.appendChild(empty);
    }
  }

  el.appendChild(body);
  addPorts(el, n);
  el.onmousedown = event => {
    if (event.target.closest('button,input,textarea,select,.port,.node-header')) return;
    selectNode(n.id, { toggle: event.shiftKey || event.ctrlKey || event.metaKey });
  };
  return el;
}

const nodeStatusLabels = {
  idle: 'Chưa chạy',
  running: 'Đang chạy',
  success: 'Xong',
  error: 'Lỗi',
  stopped: 'Đã dừng',
};

function nodeStatusText(data) {
  const status = data.status || 'idle';
  return `${nodeStatusLabels[status] || status}${data.error ? ' · ' + data.error : ''}`;
}

export function createHistoryStrip(node) {
  const history = node.data.history || [];
  const strip = document.createElement('div');
  strip.className = 'node-history';
  if (history.length < 2 || node.data.status === 'running') return strip;
  const caption = document.createElement('span');
  caption.className = 'node-history-caption';
  caption.textContent = `Phiên bản · ${history.length}`;
  strip.appendChild(caption);
  history.forEach((entry, index) => {
    const item = document.createElement('div');
    item.className = `node-history-item${entry.id === node.data.asset?.id ? ' active' : ''}`;
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.title = `Dùng phiên bản ${history.length - index}${entry.prompt ? ` · ${entry.prompt.slice(0, 120)}` : ''}`;
    const thumbUrl = entry.asset.kind === 'video' ? entry.endFrame?.url : entry.asset.url;
    if (thumbUrl) {
      const image = document.createElement('img');
      image.src = thumbUrl;
      image.alt = '';
      pick.appendChild(image);
    } else pick.textContent = `v${history.length - index}`;
    pick.onclick = event => {
      event.stopPropagation();
      if (entry.id === node.data.asset?.id) return;
      createUndoSnapshot('Đổi phiên bản kết quả', { preserveRuntime: false });
      restoreGeneration(node.data, entry.id);
      node.data.locked = true;
      render();
      saveState();
      setRunStatus(
        `Đang dùng phiên bản ${history.length - index} của kết quả node này. Phiên bản này được giữ khi bạn chạy workflow.`,
        'ok',
      );
    };
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'node-history-remove';
    remove.textContent = '×';
    remove.title = 'Xoá phiên bản này';
    remove.onclick = event => {
      event.stopPropagation();
      createUndoSnapshot('Xoá phiên bản kết quả', { preserveRuntime: false });
      removeGeneration(node.data, entry.id);
      render();
      saveState();
    };
    item.append(pick, remove);
    strip.appendChild(item);
  });
  return strip;
}

function renderVoiceoverBody(node, body) {
  const connected = getIncoming(node.id, 'text').length > 0;
  const text = document.createElement('textarea');
  text.className = 'voiceover-text';
  text.placeholder = 'Văn bản cần đọc…';
  text.value = connected ? voiceoverText(node) : node.data.text || '';
  text.readOnly = connected;
  text.title = connected ? 'Văn bản lấy từ node văn bản đang nối' : '';
  text.oninput = () => (node.data.text = text.value);
  const voice = document.createElement('input');
  voice.value = node.data.voiceId || DEFAULT_VOICE_ID;
  voice.placeholder = 'ID giọng đọc';
  voice.title = 'ID giọng đọc tvoiceai';
  voice.oninput = () => (node.data.voiceId = voice.value.trim());
  const speed = document.createElement('select');
  [0.8, 0.9, 1, 1.1, 1.2].forEach(value => {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = `Tốc độ ${value}×`;
    speed.appendChild(option);
  });
  speed.value = String(node.data.speed || 1);
  speed.onchange = () => (node.data.speed = Number(speed.value));
  const status = document.createElement('div');
  status.className = `status ${node.data.status || 'idle'}`;
  status.textContent = nodeStatusText(node.data);
  body.append(text, voice, speed, status);
  if (node.data.asset?.url) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = node.data.asset.url;
    audio.className = 'voiceover-audio';
    body.appendChild(audio);
  }
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent =
    'Nối “giọng đọc” vào một node Generate Video để trộn lời đọc này vào clip đó khi xuất MP4.';
  body.appendChild(hint);
  const actions = document.createElement('div');
  actions.className = 'node-generation-actions';
  if (node.data.asset?.url || node.data.locked) actions.appendChild(createKeepToggle(node));
  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'node-run-button primary';
  run.textContent = node.data.status === 'running' ? 'Đang tạo…' : '▶ Chạy giọng đọc';
  run.disabled = state.isRunning;
  run.onclick = event => {
    event.stopPropagation();
    runVoiceoverNode(node.id);
  };
  actions.appendChild(run);
  body.appendChild(actions);
}

function createKeepToggle(node) {
  const label = document.createElement('label');
  label.className = 'keep-result-toggle';
  label.title =
    'Chạy workflow sẽ bỏ qua node này và giữ kết quả hiện tại. Nút Chạy ảnh / Chạy video vẫn tạo lại node này.';
  label.onpointerdown = event => event.stopPropagation();
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = Boolean(node.data.locked);
  checkbox.disabled = !node.data.asset?.url && !node.data.locked;
  checkbox.onchange = () => {
    createUndoSnapshot(checkbox.checked ? 'Giữ kết quả node' : 'Bỏ giữ kết quả node');
    node.data.locked = checkbox.checked;
    saveState();
  };
  label.append(checkbox, document.createTextNode(' 🔒 Giữ kết quả này khi chạy workflow'));
  return label;
}

export function createNodeRunActions(node) {
  const actions = document.createElement('div');
  actions.className = 'node-generation-actions';
  if (node.data.asset?.url || node.data.locked) actions.appendChild(createKeepToggle(node));
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'node-run-button primary';
  if (node.data.status === 'running') {
    button.classList.add('stop');
    button.textContent = '■ Dừng';
    button.disabled = false;
    button.title = 'Dừng lượt tạo này';
    button.dataset.stopGeneration = node.id;
  } else {
    button.textContent = `▶ Chạy ${node.type === 'generateVideo' ? 'video' : 'ảnh'}`;
    button.disabled = state.isRunning;
    button.onclick = event => {
      event.stopPropagation();
      runSingleNode(node.id);
    };
  }
  actions.appendChild(button);
  if (node.type === 'generateVideo') {
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'node-run-button again';
    again.textContent = '↻ Làm lại';
    again.title = 'Tạo lại video này, bám sát hơn vào prompt và ảnh tham chiếu đang nối';
    again.disabled = state.isRunning;
    again.onclick = event => {
      event.stopPropagation();
      executeGenerationNode(node.id, { again: true });
    };
    actions.appendChild(again);
  }
  return actions;
}

export function addPorts(el, n) {
  const def = nodeDefs[n.type];
  (def.inputs || []).forEach((p, i) => {
    const y = ['generateImage', 'generateVideo'].includes(n.type)
      ? 52 + i * 26
      : n.type === 'timeline'
        ? 58 + i * 42
        : 68 + i * 42;
    const port = document.createElement('div');
    port.className = 'port in';
    port.dataset.node = n.id;
    port.dataset.port = p.id;
    port.dataset.type = p.type;
    port.style.top = `${y}px`;
    port.title = `Đầu vào: ${p.label} (${p.type})`;
    if (p.type === 'text' || p.type === 'negative')
      port.onpointerdown = e => startWireFromInput(e, n.id, p.id, p.type);
    port.ondragover = e => {
      if (state.connectingFrom && portCompatible(state.connectingFrom, n.id, p.id)) {
        e.preventDefault();
        port.classList.add('wire-compatible');
      }
    };
    port.onclick = e => {
      e.stopPropagation();
      if (state.suppressPortClick) return;
      if (state.connectingFrom) connect(n.id, p.id);
      else setRunStatus('Hãy bắt đầu từ một cổng đầu ra phù hợp, rồi bấm vào đầu vào này.', 'warn');
    };
    const label = document.createElement('span');
    label.className = 'port-label left';
    label.style.top = `${y - 1}px`;
    const count = isMultiInput(n.type, p.id) ? getIncoming(n.id, p.id).length : 0;
    label.textContent = count ? `${p.label} · ${count}` : p.label;
    if (count)
      port.title =
        n.type === 'textConcat'
          ? `Nguồn văn bản (đã nối ${count})`
          : p.id === 'prompt'
            ? `Nguồn prompt (đã nối ${count})`
            : `Ảnh tham chiếu (đã nối ${count})`;
    el.append(label, port);
  });
  (def.outputs || []).forEach((p, i) => {
    const y = ['prompt', 'negativePrompt', 'textAppend'].includes(n.type)
      ? 80
      : n.type === 'generateVideo'
        ? 82 + i * 30
        : ['imageInput', 'generateImage'].includes(n.type)
          ? 82
          : 66 + i * 42;
    const port = document.createElement('div');
    port.className = 'port out';
    port.dataset.node = n.id;
    port.dataset.port = p.id;
    port.dataset.type = p.type;
    port.style.top = `${y}px`;
    port.title = `Đầu ra: ${p.label} (${p.type})`;
    port.onpointerdown = e => startWire(e, n.id, p.id);
    if (n.type === 'generateVideo') {
      port.classList.add('video-output-port');
      port.title =
        p.id === 'endFrame'
          ? 'Nối khung hình cuối này vào đầu vào tham chiếu của video tiếp theo'
          : 'Nối video đầu ra vào Timeline hoặc một đầu vào phù hợp khác';
    }
    port.onmousedown = e => {
      if (e.button === 0) {
        e.stopPropagation();
        state.connectingFrom = { nodeId: n.id, portId: p.id };
        setRunStatus(`Đang nối ${p.type}: bấm vào một cổng đầu vào phù hợp.`, 'warn');
      }
    };
    port.onclick = e => {
      e.stopPropagation();
      if (state.suppressPortClick) return;
      if (!state.draggingWire) {
        state.connectingFrom = { nodeId: n.id, portId: p.id };
        setRunStatus(`Đang nối ${p.type}: bấm vào một đầu vào phù hợp hoặc kéo tới đó.`, 'warn');
      }
    };
    const label = document.createElement('span');
    label.className = 'port-label right';
    label.style.top = `${y - 1}px`;
    label.textContent = p.label;
    el.append(label, port);
  });
}

export function setupDrag(handle, n, el) {
  handle.onmousedown = e => {
    if (state.handMode || state.spaceDown) return;
    if (e.target.classList.contains('node-close')) return;
    e.preventDefault();
    const altCopy = e.altKey,
      modified = e.shiftKey || e.ctrlKey || e.metaKey,
      wasSelected = state.selectedNodeIds.includes(n.id);
    if (modified) {
      selectNode(n.id, { toggle: true });
      if (wasSelected) return;
    } else if (!wasSelected) selectNode(n.id);
    const sx = e.clientX,
      sy = e.clientY,
      zoom = state.zoom;
    let group = state.selectedNodeIds.includes(n.id) ? [...state.selectedNodeIds] : [n.id],
      origins = [],
      copied = false,
      undoRecorded = false,
      moved = false;
    const getOrigins = () =>
      group
        .map(id => {
          const node = nodeById(id);
          return node && { id: node.id, x: node.x, y: node.y };
        })
        .filter(Boolean);
    origins = getOrigins();
    const move = ev => {
      const rawDx = ev.clientX - sx,
        rawDy = ev.clientY - sy;
      if (altCopy && !copied) {
        if (Math.hypot(rawDx, rawDy) < 3) return;
        createUndoSnapshot('Sao chép node bằng Alt-kéo');
        group = duplicateNodesForDrag(group);
        copied = true;
        undoRecorded = true;
        origins = getOrigins();
        render();
      }
      const dx = rawDx / zoom,
        dy = rawDy / zoom;
      if (Math.abs(dx) + Math.abs(dy) < 0.1) return;
      if (!undoRecorded) {
        createUndoSnapshot('Di chuyển node');
        undoRecorded = true;
      }
      moved = true;
      for (const origin of origins) {
        const node = nodeById(origin.id);
        if (!node) continue;
        node.x = origin.x + dx;
        node.y = origin.y + dy;
        const nodeEl = document.querySelector(`.node[data-id="${CSS.escape(origin.id)}"]`);
        if (nodeEl) {
          nodeEl.style.left = `${node.x}px`;
          nodeEl.style.top = `${node.y}px`;
        }
      }
      scheduleDrawEdges();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (moved) {
        scheduleAutoSave();
        if (copied) setRunStatus('Đã tạo bản sao node.', 'ok');
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
}

export function getPortCenter(nodeId, portId, kind) {
  const q = `.port.${kind}[data-node="${CSS.escape(nodeId)}"][data-port="${CSS.escape(portId)}"]`;
  const p = document.querySelector(q);
  if (!p) return null;
  const r = p.getBoundingClientRect(),
    vr = $('#viewport').getBoundingClientRect();
  return {
    x: (r.left - vr.left - state.panX) / state.zoom + r.width / (2 * state.zoom),
    y: (r.top - vr.top - state.panY) / state.zoom + r.height / (2 * state.zoom),
  };
}

export function drawEdges() {
  edgesSvg.innerHTML = '';
  state.edges.forEach(e => {
    const a = getPortCenter(e.source, e.sourcePort, 'out'),
      b = getPortCenter(e.target, e.targetPort, 'in');
    if (!a || !b) return;
    const incoming = getIncoming(e.target, e.targetPort),
      index = incoming.findIndex(edge => edge.id === e.id),
      fan =
        isMultiInput(nodeById(e.target)?.type, e.targetPort) && incoming.length > 1
          ? (index - (incoming.length - 1) / 2) * 12
          : 0;
    const dx = b.x - a.x,
      direction = dx < 0 ? -1 : 1,
      bend = Math.max(62, Math.abs(dx) * 0.42),
      output = nodeDefs[nodeById(e.source)?.type]?.outputs?.find(port => port.id === e.sourcePort),
      d = `M ${a.x} ${a.y} C ${a.x + direction * bend} ${a.y}, ${b.x - direction * bend} ${b.y + fan}, ${b.x} ${b.y}`,
      selected = state.selectedEdgeIds.includes(e.id);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', `edge edge-${output?.type || 'media'}${selected ? ' edge-selected' : ''}`);
    path.setAttribute('d', d);
    path.setAttribute('data-edge-id', e.id);
    edgesSvg.appendChild(path);
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('class', 'edge-hit');
    hit.setAttribute('data-edge-id', e.id);
    hit.setAttribute('d', d);
    edgesSvg.appendChild(hit);
  });
  if (state.draggingWire && state.wirePointer) {
    const reverse = state.draggingWire.direction === 'in',
      a = getPortCenter(state.draggingWire.nodeId, state.draggingWire.portId, reverse ? 'in' : 'out');
    const vr = $('#viewport').getBoundingClientRect();
    if (a) {
      const x = (state.wirePointer.x - vr.left - state.panX) / state.zoom,
        y = (state.wirePointer.y - vr.top - state.panY) / state.zoom,
        dx = reverse ? a.x - x : x - a.x,
        direction = dx < 0 ? -1 : 1,
        bend = Math.max(55, Math.abs(dx) * 0.4),
        d = reverse
          ? `M ${x} ${y} C ${x + direction * bend} ${y}, ${a.x - direction * bend} ${a.y}, ${a.x} ${a.y}`
          : `M ${a.x} ${a.y} C ${a.x + direction * bend} ${a.y}, ${x - direction * bend} ${y}, ${x} ${y}`;
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('class', 'edge edge-draft');
      p.setAttribute('d', d);
      edgesSvg.appendChild(p);
    }
  }
}

export function scheduleDrawEdges() {
  if (state.edgeFrame) return;
  state.edgeFrame = requestAnimationFrame(() => {
    state.edgeFrame = 0;
    drawEdges();
  });
}

export function render() {
  syncPreviewOutputs();
  canvas.innerHTML = '';
  state.groups.forEach(group => canvas.appendChild(renderCanvasGroup(group)));
  state.notes.forEach(note => canvas.appendChild(renderCanvasNote(note)));
  state.nodes.filter(n => !n.data?.dockOnly).forEach(n => canvas.appendChild(renderNode(n)));
  applyCanvasTransform();
  requestAnimationFrame(drawEdges);
  syncTimelineDock();
  scheduleAutoSave();
}

export function renderCanvasNote(note) {
  const el = document.createElement('article');
  el.className = 'canvas-note';
  el.dataset.noteId = note.id;
  el.style.left = `${note.x}px`;
  el.style.top = `${note.y}px`;
  el.style.width = `${note.width || 260}px`;
  el.style.height = `${note.height || 160}px`;
  const header = document.createElement('header');
  header.className = 'canvas-note-header';
  const title = document.createElement('span');
  title.textContent = 'Ghi chú';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '×';
  remove.title = 'Xoá ghi chú';
  remove.onclick = event => {
    event.stopPropagation();
    createUndoSnapshot('Xoá ghi chú');
    state.notes = state.notes.filter(item => item.id !== note.id);
    render();
    saveState();
  };
  header.append(title, remove);
  header.onpointerdown = event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    event.preventDefault();
    event.stopPropagation();
    state.noteDrag = {
      id: note.id,
      startX: event.clientX,
      startY: event.clientY,
      x: note.x,
      y: note.y,
      moved: false,
    };
    try {
      header.setPointerCapture(event.pointerId);
    } catch {}
  };
  const textarea = document.createElement('textarea');
  textarea.value = note.text || '';
  textarea.placeholder = 'Viết ghi chú…';
  textarea.onbeforeinput = event => trackUndoEdit(event);
  textarea.oninput = () => {
    note.text = textarea.value;
    scheduleAutoSave();
  };
  el.append(header, textarea);
  return el;
}
export function moveTextNote(event) {
  const drag = state.noteDrag;
  if (!drag) return;
  const note = state.notes.find(item => item.id === drag.id),
    el = document.querySelector(`.canvas-note[data-note-id="${CSS.escape(drag.id)}"]`);
  if (!note || !el) return;
  const dx = (event.clientX - drag.startX) / state.zoom,
    dy = (event.clientY - drag.startY) / state.zoom;
  if (Math.abs(dx) + Math.abs(dy) < 2) return;
  if (!drag.moved) createUndoSnapshot('Di chuyển ghi chú');
  drag.moved = true;
  note.x = drag.x + dx;
  note.y = drag.y + dy;
  el.style.left = `${note.x}px`;
  el.style.top = `${note.y}px`;
}
export function finishTextNoteMove() {
  if (!state.noteDrag) return;
  const moved = state.noteDrag.moved;
  state.noteDrag = null;
  if (moved) {
    render();
    saveState();
  }
}

export function renderCanvasGroup(group) {
  const frame = document.createElement('div');
  frame.className = 'canvas-group';
  frame.style.left = `${group.x}px`;
  frame.style.top = `${group.y}px`;
  frame.style.width = `${group.width}px`;
  frame.style.height = `${group.height}px`;
  const label = document.createElement('span');
  label.className = 'canvas-group-label';
  label.textContent = group.name || 'Nhóm';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'canvas-group-delete';
  remove.textContent = '×';
  remove.title = 'Xoá vùng nhóm';
  remove.setAttribute('aria-label', 'Xoá vùng nhóm');
  remove.onclick = event => {
    event.stopPropagation();
    createUndoSnapshot('Xoá vùng nhóm');
    state.groups = state.groups.filter(item => item.id !== group.id);
    render();
    saveState();
  };
  frame.append(label, remove);
  return frame;
}

export function syncPreviewOutputs() {
  for (const preview of state.nodes.filter(node => node.type === 'preview')) {
    const edge = getIncoming(preview.id, 'media')[0],
      source = edge && nodeById(edge.source);
    let asset = null;
    if (source) {
      asset = edge.sourcePort === 'endFrame' ? source.data?.endFrame : source.data?.asset;
      if (!asset && source.type === 'imageInput' && source.data?.localDataUrl)
        asset = { id: source.id, kind: 'image', url: source.data.localDataUrl, name: 'Input image' };
    }
    preview.data.asset = asset || null;
  }
}
