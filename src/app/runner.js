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
  normalizeSavedGraph,
} from '../core/graph.js';
import { buildMusePrompt, buildRefusalRetryPrompt, isRatioMismatch } from '../core/prompts.js';
import { recordGeneration } from '../core/history.js';
import { APP_NAME, APP_VERSION } from './app-info.js';
import { $, runStatus, setRunStatus } from './dom.js';
import { loadImage, drawResized, mediaDimensions, extractVideoEndFrame, persistImage } from './media.js';
import { autoSaveTimer, queueWorkflowSave } from './persistence.js';
import { render } from './render.js';
import { MESSAGE, preferredMuseTabId, museTabMessage, sendMuseStop } from './muse-client.js';

export function validateTargetPrompt(targetId) {
  const target = nodeById(targetId);
  if (!target || !['generateImage', 'generateVideo'].includes(target.type))
    throw new Error('Selected generation node no longer exists.');
  const prompt = resolvePrompt(targetId);
  if (prompt.trim()) return prompt;
  const edge = getIncoming(targetId, 'prompt')[0],
    source = edge && nodeById(edge.source);
  const detail = !edge
    ? 'Connect a Prompt, Text Append, or Text Merge node to this prompt input.'
    : !source
      ? 'The connected prompt node no longer exists.'
      : `The connected ${nodeDefs[source.type]?.title || 'text'} node has no text.`;
  target.data.status = 'error';
  target.data.error = detail;
  render();
  throw new Error(`${nodeDefs[target.type]?.title || 'Generation node'} ${target.id}: ${detail}`);
}

export function stopGeneration(nodeId = state.activeGenerationId) {
  if (!nodeId) return;
  const node = nodeById(nodeId);
  if (!node || node.data.status !== 'running') return;
  const requestId = state.activeGenerationId === nodeId ? state.generationRequestId : null;
  if (state.activeGenerationId === nodeId) state.generationAbortController?.abort();
  if (node) {
    node.data.status = 'stopped';
    node.data.error = 'Generation stopped by user.';
  }
  setRunStatus(`Stopped ${node?.type === 'generateVideo' ? 'video' : 'image'} generation: ${nodeId}`, 'warn');
  render();
  // Cancellation is best-effort for Muse, but never wait for its response to unlock the UI.
  void sendMuseStop(requestId);
  try {
    clearTimeout(autoSaveTimer);
    void queueWorkflowSave();
  } catch {}
}

const stoppedError = () => new DOMException('Generation stopped by user.', 'AbortError');
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
    setRunStatus('Image Resize is waiting for an input image.', 'warn');
    return;
  }
  const image = await loadImage(url),
    canvas = document.createElement('canvas');
  drawResized(image, canvas, node.data);
  node.data.asset = {
    id: uid('asset'),
    kind: 'image',
    url: canvas.toDataURL('image/png'),
    name: `Resized ${node.data.width}×${node.data.height}`,
    width: canvas.width,
    height: canvas.height,
    sourceNodeId: node.id,
  };
  publishToPreviews(node);
  render();
}

async function requestMuseMedia(node, request, signal) {
  let reply = await museTabMessage(request, preferredMuseTabId, signal);
  if (signal.aborted) throw stoppedError();
  if (!reply?.ok && reply?.code === 'SCENE_REFUSED') {
    setRunStatus(
      `Muse could not create ${node.data.sceneLabel || 'this scene'}; retrying once with a close, safe alternative…`,
      'warn',
    );
    reply = await museTabMessage(
      { ...request, requestId: uid('generation'), prompt: buildRefusalRetryPrompt(request.prompt) },
      preferredMuseTabId,
      signal,
    );
  }
  if (signal.aborted) throw stoppedError();
  if (!reply?.ok) throw new Error(reply?.error || `Muse.ai did not return a generated ${request.mediaType}.`);
  return reply;
}

async function generateNode(node, { again, signal, progressLabel }) {
  const isVideo = node.type === 'generateVideo',
    mediaType = isVideo ? 'video' : 'image';
  const prompt = resolvePrompt(node.id);
  if (!String(prompt).trim())
    throw new Error(
      `${nodeDefs[node.type].title} ${node.id}: connect a Prompt, Text Append, or Text Merge node first.`,
    );
  const negativePrompt = resolveNegativePrompt(node.id);
  const continuityPrevious = isVideo && node.data.continuity ? timelinePredecessor(node.id) : null,
    continuityStartFrame = continuityPrevious?.data?.endFrame?.url ? continuityPrevious.data.endFrame : null;
  if (isVideo && node.data.continuity && !continuityStartFrame)
    throw new Error(
      `End-frame continuity for ${node.id} needs the previous Timeline clip to be generated successfully with an extractable final frame. Put clips in order and run the previous clip first.`,
    );
  const referenceImages = resolveReferences(node.id);
  state.activeGenerationId = node.id;
  node.data.status = 'running';
  node.data.error = '';
  node.data.asset = null;
  node.data.endFrame = null;
  publishToPreviews(node);
  render();
  setRunStatus(`${progressLabel} · generating ${mediaType}: ${node.id}`, 'warn');
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
    });
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
        referenceImages: referenceImages.map(item => item.url),
        timeoutSec: 600,
      };
      state.generationRequestId = request.requestId;
      try {
        reply = await requestMuseMedia(node, request, signal);
        break;
      } catch (error) {
        if (isAbort(error, signal) || attempt >= retries) throw error;
        setRunStatus(
          `${progressLabel} · ${error?.message || error} · automatic retry ${attempt + 1}/${retries}…`,
          'warn',
        );
      }
    }
    const url = isVideo ? reply.url : await persistImage(reply.url);
    if (!url) throw new Error(`Muse.ai returned an empty ${mediaType} attachment.`);
    const intrinsic = await mediaDimensions(url, mediaType);
    if (isRatioMismatch(intrinsic.width, intrinsic.height, node.data.size))
      throw new Error(
        `Muse returned ${intrinsic.width} × ${intrinsic.height}, which does not match the requested ${node.data.size} aspect ratio. The old result was cleared; retry generation after checking the Muse output.`,
      );
    node.data.asset = {
      id: uid('asset'),
      kind: mediaType,
      url,
      name: `${isVideo ? 'Video' : 'Image'} ${node.id}`,
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
      node.data.status = 'stopped';
      node.data.error = 'Generation stopped by user.';
      render();
      throw stoppedError();
    }
    node.data.status = 'error';
    node.data.error = err?.message || String(err);
    render();
    throw err;
  }
}

function hasFailedUpstream(nodeId, failed) {
  if (state.edges.some(edge => edge.target === nodeId && failed.has(edge.source))) return true;
  const node = nodeById(nodeId);
  const previous =
    node?.type === 'generateVideo' && node.data?.continuity ? timelinePredecessor(nodeId) : null;
  return Boolean(previous && failed.has(previous.id));
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
      if (node.data.status === 'idle') node.data.error = 'Previous run was interrupted; ready to retry.';
    }
  const abortController = new AbortController(),
    signal = abortController.signal;
  state.generationAbortController = abortController;
  state.activeGenerationId = targetId;
  state.isRunning = true;
  $('#runBtn').disabled = false;
  $('#runBtn').textContent = '■ Stop workflow';
  $('#runBtn').title = 'Stop the running workflow and its remaining nodes';
  setRunStatus(
    targetId
      ? again
        ? 'Regenerating video with stronger prompt adherence…'
        : 'Running selected generation node…'
      : 'Running workflow...',
    'warn',
  );
  const continueOnError = !targetId && Boolean(state.settings?.continueOnError);
  const failures = [];
  try {
    if (targetId) validateTargetPrompt(targetId);
    const order = targetId
      ? requiredNodeOrder(targetId).filter(id => {
          const prerequisite = nodeById(id);
          return id === targetId || !isGenerator(prerequisite) || !prerequisite.data?.asset?.url;
        })
      : topoOrder();
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
    const failed = new Set();
    for (const id of order) {
      if (signal.aborted) throw stoppedError();
      const n = nodeById(id);
      if (!n) continue;
      if (continueOnError && hasFailedUpstream(id, failed)) {
        failed.add(id);
        if (isGenerator(n)) {
          generationStep++;
          n.data.status = 'error';
          n.data.error = 'Skipped because an upstream node failed.';
          render();
        }
        continue;
      }
      try {
        if (n.type === 'imageResize') await runImageResize(n);
        else if (isGenerator(n)) {
          generationStep++;
          await generateNode(n, {
            again,
            signal,
            progressLabel: targetId ? 'Selected node' : `Generation ${generationStep}/${totalGenerations}`,
          });
        }
      } catch (error) {
        if (isAbort(error, signal) || !continueOnError) throw error;
        failed.add(id);
        failures.push({ node: n, message: error?.message || String(error) });
      }
    }
    try {
      await saveAfterRun();
      if (failures.length)
        setRunStatus(
          `Workflow finished with ${failures.length} failed node${failures.length === 1 ? '' : 's'} · ${failures[0].node.data.customName || failures[0].node.id}: ${failures[0].message}`,
          'error',
        );
      else setRunStatus(targetId ? 'Node generation completed.' : 'Workflow completed.', 'ok');
    } catch (saveError) {
      setRunStatus(
        `Generation completed, but workflow could not be saved: ${saveError?.message || String(saveError)}`,
        'warn',
      );
    }
  } catch (err) {
    if (isAbort(err, signal)) {
      const active = state.nodes.find(n => n.id === state.activeGenerationId);
      if (active && active.data.status === 'running') {
        active.data.status = 'stopped';
        active.data.error = 'Generation stopped by user.';
        render();
      }
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
    setRunStatus(
      /failed to fetch/i.test(message)
        ? `Muse connection failed. Reload ${APP_NAME} ${APP_VERSION}, then check the Muse session.`
        : `${APP_NAME} ${APP_VERSION} · ${message}`,
      'error',
    );
    try {
      await saveAfterRun();
    } catch (saveError) {
      setRunStatus(
        `${runStatus.textContent} · Auto-save failed: ${saveError?.message || String(saveError)}`,
        'error',
      );
    }
  } finally {
    state.isRunning = false;
    state.activeGenerationId = null;
    state.generationAbortController = null;
    state.generationRequestId = null;
    $('#runBtn').disabled = false;
    $('#runBtn').textContent = '▶ Run workflow';
    $('#runBtn').title = 'Run every node in the workflow in dependency order';
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
