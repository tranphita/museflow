import { state } from '../core/state.js';
import { nodeDefs, uid, isGenerator } from '../core/node-defs.js';
import {
  nodeById,
  getIncoming,
  sourceFor,
  timelinePredecessor,
  topoOrder,
  requiredNodeOrder,
  resolvePrompt,
  resolveNegativePrompt,
  resolveReferences,
  resolveText,
  normalizeSavedGraph,
} from '../core/graph.js';
import { synthesizeSpeech, missingTtsKeyProvider } from './tts-client.js';
import { openTtsKeySettings } from './tts-settings-ui.js';
import { startRun, markStep, finishRun, showRunPanel, stepLabel, setStepRestarter } from './run-panel.js';
import { buildMusePrompt, buildRefusalRetryPrompt, isRatioMismatch } from '../core/prompts.js';
import { recordGeneration } from '../core/history.js';
import { APP_NAME, APP_VERSION } from './app-info.js';
import { $, runStatus, setRunStatus } from './dom.js';
import {
  loadImage,
  drawResized,
  mediaDimensions,
  extractVideoEndFrame,
  persistImage,
  blobAsDataUrl,
} from './media.js';
import { autoSaveTimer, queueWorkflowSave } from './persistence.js';
import { render } from './render.js';
import { MESSAGE, preferredMuseTabId, museTabMessage, sendMuseStop, queryMuseTabs } from './muse-client.js';

export function validateTargetPrompt(targetId) {
  const target = nodeById(targetId);
  if (!target || !['generateImage', 'generateVideo'].includes(target.type))
    throw new Error('Node tạo đã chọn không còn tồn tại.');
  const prompt = resolvePrompt(targetId);
  if (prompt.trim()) return prompt;
  const edge = getIncoming(targetId, 'prompt')[0],
    source = edge && nodeById(edge.source);
  const detail = !edge
    ? 'Hãy nối một node Prompt, Text Append hoặc Text Merge vào ô prompt này.'
    : !source
      ? 'Node prompt đã nối không còn tồn tại.'
      : `Node ${nodeDefs[source.type]?.title || 'văn bản'} đã nối chưa có nội dung.`;
  target.data.status = 'error';
  target.data.error = detail;
  render();
  throw new Error(`${nodeDefs[target.type]?.title || 'Node tạo'} ${target.id}: ${detail}`);
}

export function stopGeneration(nodeId = state.activeGenerationId) {
  if (!nodeId) return;
  const node = nodeById(nodeId);
  if (!node || node.data.status !== 'running') return;
  if (state.activeGenerationId === nodeId) state.generationAbortController?.abort();
  if (node) {
    node.data.status = 'stopped';
    node.data.error = 'Đã dừng tạo theo yêu cầu của bạn.';
  }
  setRunStatus(`Đã dừng tạo ${node?.type === 'generateVideo' ? 'video' : 'ảnh'}: ${nodeId}`, 'warn');
  render();
  // Cancellation is best-effort for Muse, but never wait for its response to unlock the UI.
  void sendMuseStop(null);
  try {
    clearTimeout(autoSaveTimer);
    void queueWorkflowSave();
  } catch {}
}

const stoppedError = () => new DOMException('Đã dừng tạo theo yêu cầu của bạn.', 'AbortError');
const isAbort = (error, signal) => error?.name === 'AbortError' || signal?.aborted;

function publishToPreviews(node) {
  for (const edge of state.edges.filter(item => item.source === node.id)) {
    const target = nodeById(edge.target);
    if (target?.type === 'preview')
      target.data.asset = edge.sourcePort === 'endFrame' ? node.data.endFrame : node.data.asset;
  }
}

async function runImageResize(node) {
  const source = sourceFor(getIncoming(node.id, 'image')[0]);
  const url = source?.data?.localDataUrl || source?.data?.asset?.url;
  if (!url) {
    setRunStatus('Image Resize đang chờ ảnh đầu vào.', 'warn');
    return;
  }
  const image = await loadImage(url),
    canvas = document.createElement('canvas');
  drawResized(image, canvas, node.data);
  node.data.asset = {
    id: uid('asset'),
    kind: 'image',
    url: canvas.toDataURL('image/png'),
    name: `Ảnh đổi cỡ ${node.data.width}×${node.data.height}`,
    width: canvas.width,
    height: canvas.height,
    sourceNodeId: node.id,
  };
  publishToPreviews(node);
  render();
}

const producesMedia = node => isGenerator(node) || node?.type === 'voiceover';

export function voiceoverText(node) {
  const source = sourceFor(getIncoming(node.id, 'text')[0]);
  return (source ? resolveText(source.id) : String(node.data.text || '')).trim();
}

async function runVoiceover(node, signal) {
  node.data.status = 'running';
  node.data.error = '';
  render();
  setRunStatus(`Đang tạo lồng tiếng: ${node.data.customName || node.data.sceneLabel || node.id}`, 'warn');
  try {
    const url = await synthesizeSpeech(voiceoverText(node), {
      voiceId: node.data.voiceId,
      speed: node.data.speed,
      signal,
    });
    const duration = await audioDuration(url);
    node.data.asset = { id: uid('voice'), kind: 'audio', url, name: `Lồng tiếng ${node.id}`, duration };
    node.data.status = 'success';
    render();
  } catch (error) {
    node.data.status = isAbort(error, signal) ? 'stopped' : 'error';
    node.data.error = isAbort(error, signal)
      ? 'Đã dừng lồng tiếng theo yêu cầu của bạn.'
      : error?.message || String(error);
    render();
    throw error;
  }
}

function audioDuration(url) {
  return new Promise(resolve => {
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => resolve(0);
    audio.src = url;
  });
}

async function ensureTtsApiKey(voiceNodes) {
  const missing = await missingTtsKeyProvider(voiceNodes.map(node => node.data.voiceId));
  if (!missing) return true;
  await openTtsKeySettings(missing);
  return false;
}

export async function runVoiceoverNode(nodeId) {
  const node = nodeById(nodeId);
  if (!node || node.type !== 'voiceover' || state.isRunning) return;
  if (!(await ensureTtsApiKey([node]))) {
    setRunStatus('Dán API key giọng đọc vào Cài đặt → Lồng tiếng, bấm Lưu rồi chạy lại giọng đọc.', 'warn');
    return;
  }
  state.isRunning = true;
  const controller = new AbortController();
  state.generationAbortController = controller;
  startRun([node.id], { single: true });
  showRunPanel();
  markStep(node.id, 'running');
  try {
    await runVoiceover(node, controller.signal);
    markStep(node.id, 'done');
    finishRun('done');
    await saveAfterRun();
    setRunStatus('Đã tạo lồng tiếng.', 'ok');
  } catch (error) {
    const stopped = isAbort(error, controller.signal);
    markStep(node.id, stopped ? 'stopped' : 'error', error?.message || String(error));
    finishRun(stopped ? 'stopped' : 'error', error?.message || String(error));
    if (!stopped) setRunStatus(error?.message || String(error), 'error');
  } finally {
    state.isRunning = false;
    state.generationAbortController = null;
    render();
  }
}

async function requestMuseMedia(node, request, signal, tabId) {
  const send = message =>
    tabId === undefined
      ? museTabMessage(message, preferredMuseTabId, signal)
      : museTabMessage(message, tabId, signal, { onlyThisTab: true });
  let reply = await send(request);
  if (signal.aborted) throw stoppedError();
  if (!reply?.ok && reply?.code === 'SCENE_REFUSED') {
    setRunStatus(
      `Muse không tạo được ${node.data.sceneLabel || 'cảnh này'}; đang tự thử lại một lần với phương án gần giống và an toàn hơn…`,
      'warn',
    );
    reply = await send({
      ...request,
      requestId: uid('generation'),
      prompt: buildRefusalRetryPrompt(request.prompt),
    });
  }
  if (signal.aborted) throw stoppedError();
  if (!reply?.ok)
    throw new Error(
      reply?.error || `Muse.ai không trả về ${request.mediaType === 'video' ? 'video' : 'ảnh'} nào.`,
    );
  return reply;
}

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

async function generateNode(node, { again, signal, progressLabel, tabId }) {
  const isVideo = node.type === 'generateVideo',
    mediaType = isVideo ? 'video' : 'image',
    mediaWord = isVideo ? 'video' : 'ảnh';
  const prompt = resolvePrompt(node.id);
  if (!String(prompt).trim())
    throw new Error(
      `${nodeDefs[node.type].title} ${node.id}: hãy nối một node Prompt, Text Append hoặc Text Merge trước.`,
    );
  const negativePrompt = resolveNegativePrompt(node.id);
  const continuityPrevious = isVideo && node.data.continuity ? timelinePredecessor(node.id) : null,
    continuityStartFrame = continuityPrevious?.data?.endFrame?.url ? continuityPrevious.data.endFrame : null;
  if (isVideo && node.data.continuity && !continuityStartFrame)
    throw new Error(
      `Nối tiếp từ khung cuối cho ${node.id} cần clip trước đó trên Timeline đã tạo thành công và lấy được khung hình cuối. Hãy xếp clip đúng thứ tự và chạy clip trước đó trước.`,
    );
  const referenceImages = resolveReferences(node.id);
  state.activeGenerationId = node.id;
  node.data.status = 'running';
  node.data.error = '';
  node.data.asset = null;
  node.data.endFrame = null;
  publishToPreviews(node);
  render();
  setRunStatus(`${progressLabel} · đang tạo ${mediaWord}: ${stepLabel(node)}`, 'warn');
  let museRequestId = '';
  try {
    const musePrompt = buildMusePrompt({
      mediaType,
      size: node.data.size,
      duration: node.data.duration,
      prompt,
      negativePrompt,
      referenceCount: referenceImages.length,
      continuityFrame: Boolean(continuityStartFrame),
      again: isVideo && again,
      characterNames: referenceImages.map(item => item.character),
      nextShot: isVideo ? node.data.nextShot || '' : '',
      continuityRules: node.data.continuityRules || [],
    });
    const cooldownMs = (Number(state.settings?.cooldownSec) || 0) * 1000;
    if (cooldownMs) await abortableDelay(cooldownMs, signal);
    const referenceUrls = await Promise.all(referenceImages.map(item => transferableUrl(item.url)));
    const retries = Math.max(0, Math.min(2, Number(state.settings?.autoRetry) || 0));
    let reply;
    for (let attempt = 0; ; attempt++) {
      const request = {
        type: MESSAGE.generate,
        requestId: uid('generation'),
        prompt: musePrompt,
        negativePrompt,
        size: node.data.size,
        model: node.data.model,
        duration: node.data.duration,
        mediaType,
        referenceImages: referenceUrls,
        timeoutSec: 600,
      };
      state.generationRequestId = request.requestId;
      museRequestId = request.requestId;
      try {
        reply = await requestMuseMedia(node, request, signal, tabId);
        break;
      } catch (error) {
        if (isAbort(error, signal) || attempt >= retries) throw error;
        setRunStatus(
          `${progressLabel} · ${error?.message || error} · tự thử lại ${attempt + 1}/${retries}…`,
          'warn',
        );
      }
    }
    const url = isVideo ? reply.url : await persistImage(reply.url);
    if (!url) throw new Error(`Muse.ai trả về ${mediaWord} rỗng.`);
    const intrinsic = await mediaDimensions(url, mediaType);
    if (isRatioMismatch(intrinsic.width, intrinsic.height, node.data.size))
      throw new Error(
        `Muse trả về ${intrinsic.width} × ${intrinsic.height}, không khớp tỉ lệ khung hình ${node.data.size} đã yêu cầu. Kết quả cũ đã bị xoá; hãy kiểm tra kết quả trên Muse rồi tạo lại.`,
      );
    node.data.asset = {
      id: uid('asset'),
      kind: mediaType,
      url,
      name: `${isVideo ? 'Video' : 'Ảnh'} ${node.id}`,
      sourceNodeId: node.id,
      width: intrinsic.width,
      height: intrinsic.height,
      requestedSize: node.data.size,
      sizeMismatch: false,
    };
    node.data.status = 'success';
    if (isVideo) node.data.endFrame = await extractVideoEndFrame(url);
    recordGeneration(node.data, { asset: node.data.asset, endFrame: node.data.endFrame, prompt });
    publishToPreviews(node);
    render();
  } catch (err) {
    if (isAbort(err, signal)) {
      if (museRequestId) void sendMuseStop(museRequestId);
      node.data.status = 'stopped';
      node.data.error = 'Đã dừng tạo theo yêu cầu của bạn.';
      render();
      throw stoppedError();
    }
    node.data.status = 'error';
    node.data.error = err?.message || String(err);
    render();
    throw err;
  }
}

const TTS_PARALLEL = 3;

function stepDependencies(nodeId, inRun) {
  const deps = new Set(state.edges.filter(edge => edge.target === nodeId).map(edge => edge.source));
  const node = nodeById(nodeId);
  const previous =
    node?.type === 'generateVideo' && node.data?.continuity ? timelinePredecessor(nodeId) : null;
  if (previous) deps.add(previous.id);
  return [...deps].filter(id => inRun.has(id));
}

async function museTabPool() {
  if (state.pinnedMuseTabId) return [state.pinnedMuseTabId];
  const wanted = Math.max(1, Math.min(3, Number(state.settings?.museTabs) || 1));
  if (wanted === 1) return [undefined];
  const seen = new Set();
  const tabs = (await queryMuseTabs()).filter(tab => {
    const thread = /\/thread\/[^/?#]+/.exec(tab.url || '')?.[0];
    if (!tab.id || (thread && seen.has(thread))) return false;
    if (thread) seen.add(thread);
    return true;
  });
  return tabs.length > 1 ? tabs.slice(0, wanted).map(tab => tab.id) : [undefined];
}

async function saveAfterRun() {
  clearTimeout(autoSaveTimer);
  await queueWorkflowSave();
}

export async function execute(targetId = null, { again = false } = {}) {
  if (state.isRunning) return;
  // Keep runtime graph references valid even if an older saved workflow or
  // an interrupted UI action left stale node IDs behind.
  normalizeSavedGraph();
  // A persisted "running" flag can survive a tab reload even though the old
  // request no longer exists. Normalize it before starting a fresh run.
  for (const node of state.nodes)
    if (isGenerator(node) && node.data.status === 'running') {
      node.data.status = node.data.asset?.url ? 'success' : 'idle';
      if (node.data.status === 'idle') node.data.error = 'Lượt chạy trước bị gián đoạn; có thể thử lại.';
    }
  const abortController = new AbortController(),
    signal = abortController.signal;
  state.generationAbortController = abortController;
  state.activeGenerationId = targetId;
  state.isRunning = true;
  $('#runBtn').disabled = false;
  $('#runBtn').textContent = '■ Dừng workflow';
  $('#runBtn').title = 'Dừng workflow đang chạy và các node còn lại';
  setRunStatus(
    targetId
      ? again
        ? 'Đang tạo lại video, bám prompt sát hơn…'
        : 'Đang chạy node tạo đã chọn…'
      : 'Đang chạy workflow…',
    'warn',
  );
  const continueOnError = !targetId && Boolean(state.settings?.continueOnError);
  const failures = [];
  let runStarted = false;
  try {
    if (targetId) validateTargetPrompt(targetId);
    const order = targetId
      ? requiredNodeOrder(targetId).filter(id => {
          const prerequisite = nodeById(id);
          return id === targetId || !producesMedia(prerequisite) || !prerequisite.data?.asset?.url;
        })
      : topoOrder();
    const voicesToCreate = order
      .map(nodeById)
      .filter(
        item => item?.type === 'voiceover' && !(item.data.asset?.url && (item.data.locked || targetId)),
      );
    if (voicesToCreate.length && !(await ensureTtsApiKey(voicesToCreate)))
      throw new Error('Dán API key giọng đọc vào Cài đặt → Lồng tiếng, bấm Lưu rồi chạy lại.');
    startRun(
      order.filter(id => producesMedia(nodeById(id)) || nodeById(id)?.type === 'imageResize'),
      { single: Boolean(targetId) },
    );
    showRunPanel();
    runStarted = true;
    for (const n of state.nodes) {
      if (n.type === 'imageInput' && n.data.localDataUrl)
        n.data.asset = {
          id: n.data.asset?.id || uid('asset'),
          kind: 'image',
          url: n.data.localDataUrl,
          sourceNodeId: n.id,
        };
    }
    let generationStep = 0;
    const totalGenerations = order.filter(id => isGenerator(nodeById(id))).length;
    const failed = new Set(),
      settled = new Set(),
      inRun = new Set(order);
    const tabPool = await museTabPool();
    const capacity = { muse: tabPool.length, tts: TTS_PARALLEL, local: 1 },
      busy = { muse: 0, tts: 0, local: 0 };
    const laneOf = node => (isGenerator(node) ? 'muse' : node.type === 'voiceover' ? 'tts' : 'local');
    const runController = new AbortController();
    const stopRun = () => runController.abort();
    signal.addEventListener('abort', stopRun, { once: true });
    const pending = [...order],
      running = new Map(),
      stepControllers = new Map(),
      restarting = new Set();
    let fatal = null;
    setStepRestarter(id => {
      const controller = stepControllers.get(id);
      if (!controller || controller.signal.aborted || runController.signal.aborted) return;
      restarting.add(id);
      controller.abort();
      setRunStatus(`Đã dừng và đang chạy lại: ${stepLabel(nodeById(id))}`, 'warn');
    });
    const startStep = node => {
      const lane = laneOf(node),
        tabId = lane === 'muse' ? tabPool.shift() : undefined;
      busy[lane]++;
      markStep(node.id, 'running');
      const stepController = new AbortController();
      stepControllers.set(node.id, stepController);
      const stepSignal = AbortSignal.any([runController.signal, stepController.signal]);
      const generationNumber = isGenerator(node) ? ++generationStep : 0;
      const work =
        node.type === 'imageResize'
          ? runImageResize(node)
          : node.type === 'voiceover'
            ? runVoiceover(node, stepSignal)
            : generateNode(node, {
                again,
                signal: stepSignal,
                tabId,
                progressLabel: targetId ? 'Node đã chọn' : `Lượt tạo ${generationNumber}/${totalGenerations}`,
              });
      let requeued = false;
      const task = work
        .then(
          () => markStep(node.id, 'done'),
          error => {
            if (restarting.delete(node.id) && !runController.signal.aborted) {
              requeued = true;
              if (generationNumber) generationStep--;
              markStep(node.id, 'pending');
              pending.unshift(node.id);
              return;
            }
            const stopped = isAbort(error, runController.signal);
            markStep(node.id, stopped ? 'stopped' : 'error', error?.message || String(error));
            failed.add(node.id);
            if (stopped || !continueOnError) fatal ??= error;
            else failures.push({ node, message: error?.message || String(error) });
          },
        )
        .finally(() => {
          busy[lane]--;
          if (lane === 'muse') tabPool.push(tabId);
          stepControllers.delete(node.id);
          restarting.delete(node.id);
          if (!requeued) settled.add(node.id);
          running.delete(node.id);
        });
      running.set(node.id, task);
    };
    try {
      while ((pending.length && !fatal) || running.size) {
        if (signal.aborted) throw stoppedError();
        for (let index = 0; index < pending.length && !fatal; ) {
          const id = pending[index],
            n = nodeById(id);
          const waitingOn = n ? stepDependencies(id, inRun).filter(dep => !settled.has(dep)) : [];
          if (waitingOn.length) {
            index++;
            continue;
          }
          if (!n || !(producesMedia(n) || n.type === 'imageResize')) {
            pending.splice(index, 1);
            settled.add(id);
            continue;
          }
          if (!targetId && producesMedia(n) && n.data.locked && n.data.asset?.url) {
            if (isGenerator(n)) generationStep++;
            publishToPreviews(n);
            markStep(id, 'kept');
            pending.splice(index, 1);
            settled.add(id);
            continue;
          }
          const blocker = stepDependencies(id, inRun).find(dep => failed.has(dep));
          if (blocker) {
            const reason = `Đã bỏ qua: cần “${stepLabel(nodeById(blocker))}” nhưng bước đó chưa xong.`;
            if (isGenerator(n)) {
              generationStep++;
              n.data.status = 'error';
              n.data.error = reason;
              render();
            }
            markStep(id, 'skipped', reason);
            failed.add(id);
            pending.splice(index, 1);
            settled.add(id);
            continue;
          }
          const lane = laneOf(n);
          if (busy[lane] >= capacity[lane]) {
            index++;
            continue;
          }
          pending.splice(index, 1);
          startStep(n);
        }
        if (fatal) stopRun();
        if (!running.size) break;
        await Promise.race(running.values());
      }
    } finally {
      signal.removeEventListener('abort', stopRun);
      setStepRestarter(null);
    }
    if (signal.aborted) throw stoppedError();
    if (fatal) throw fatal;
    finishRun(
      'done',
      failures.length ? `${failures.length} bước bị lỗi; các node phụ thuộc vào chúng đã được bỏ qua.` : '',
    );
    try {
      await saveAfterRun();
      if (failures.length)
        setRunStatus(
          `Workflow đã chạy xong nhưng có ${failures.length} node bị lỗi · ${failures[0].node.data.customName || failures[0].node.id}: ${failures[0].message}`,
          'error',
        );
      else setRunStatus(targetId ? 'Node đã tạo xong.' : 'Workflow đã chạy xong.', 'ok');
    } catch (saveError) {
      setRunStatus(
        `Đã tạo xong nhưng không lưu được workflow: ${saveError?.message || String(saveError)}`,
        'warn',
      );
    }
  } catch (err) {
    if (isAbort(err, signal)) {
      const active = state.nodes.find(n => n.id === state.activeGenerationId);
      if (active && active.data.status === 'running') {
        active.data.status = 'stopped';
        active.data.error = 'Đã dừng tạo theo yêu cầu của bạn.';
        render();
      }
      if (runStarted) finishRun('stopped', 'Bạn đã dừng.');
      try {
        await saveAfterRun();
      } catch {}
      return;
    }
    const failedNode = state.nodes.find(n => isGenerator(n) && n.data.status === 'running');
    if (failedNode) {
      failedNode.data.status = 'error';
      failedNode.data.error = err?.message || String(err);
      render();
    }
    const message = err?.message || String(err);
    if (runStarted) finishRun('error', message);
    setRunStatus(
      /failed to fetch/i.test(message)
        ? `Kết nối Muse thất bại. Tải lại ${APP_NAME} ${APP_VERSION} rồi kiểm tra phiên Muse.`
        : `${APP_NAME} ${APP_VERSION} · ${message}`,
      'error',
    );
    try {
      await saveAfterRun();
    } catch (saveError) {
      setRunStatus(
        `${runStatus.textContent} · Tự động lưu thất bại: ${saveError?.message || String(saveError)}`,
        'error',
      );
    }
  } finally {
    state.isRunning = false;
    state.activeGenerationId = null;
    state.generationAbortController = null;
    state.generationRequestId = null;
    $('#runBtn').disabled = false;
    $('#runBtn').textContent = '▶ Chạy workflow';
    $('#runBtn').title = 'Chạy mọi node trong workflow theo thứ tự phụ thuộc';
    render();
  }
}

export function executeWorkflow() {
  return execute();
}
export function executeGenerationNode(nodeId, options = {}) {
  const node = nodeById(nodeId);
  if (!node || !['generateImage', 'generateVideo'].includes(node.type)) return;
  if (node.data.status === 'running') {
    stopGeneration(nodeId);
    return;
  }
  return execute(nodeId, options);
}
export function runSingleNode(nodeId) {
  return executeGenerationNode(nodeId);
}
export function onWorkflowRunButtonClick(event) {
  if (event.detail > 1) return;
  if (state.isRunning) stopGeneration(state.activeGenerationId);
  else executeWorkflow();
}
