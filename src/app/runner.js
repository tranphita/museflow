import { state } from '../core/state.js';
import { nodeDefs, uid } from '../core/node-defs.js';
import { nodeById, getIncoming, sourceFor, timelinePredecessor, topoOrder, requiredNodeOrder, resolvePrompt, resolveNegativePrompt, resolveReferences, normalizeSavedGraph } from '../core/graph.js';
import { ratioValue } from '../core/media-math.js';
import { $, runStatus, setRunStatus } from './dom.js';
import { loadImage, drawResized, mediaDimensions, extractVideoEndFrame, persistImage } from './media.js';
import { autoSaveTimer, queueWorkflowSave } from './persistence.js';
import { render } from './render.js';
import { preferredMuseTabId, museTabMessage, sendMuseStop } from './muse-client.js';

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
  setRunStatus(
    `Stopped ${node?.type === 'generateVideo' ? 'video' : 'image'} generation: ${nodeId}`,
    'warn',
  );
  render();
  // Cancellation is best-effort for Muse, but never wait for its response to unlock the UI.
  void sendMuseStop(requestId);
  try {
    clearTimeout(autoSaveTimer);
    void queueWorkflowSave();
  } catch {}
}

export async function execute(targetId = null, { again = false } = {}) {
  if (state.isRunning) return;
  // Keep runtime graph references valid even if an older saved workflow or
  // an interrupted UI action left stale node IDs behind.
  normalizeSavedGraph();
  // A persisted "running" flag can survive a tab reload even though the old
  // request no longer exists. Normalize it before starting a fresh run.
  for (const node of state.nodes)
    if (['generateImage', 'generateVideo'].includes(node.type) && node.data.status === 'running') {
      node.data.status = node.data.asset?.url ? 'success' : 'idle';
      if (node.data.status === 'idle') node.data.error = 'Previous run was interrupted; ready to retry.';
    }
  const abortController = new AbortController();
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
  try {
    if (targetId) validateTargetPrompt(targetId);
    const order = targetId
      ? requiredNodeOrder(targetId).filter(id => {
          const prerequisite = nodeById(id);
          return (
            id === targetId ||
            !['generateImage', 'generateVideo'].includes(prerequisite?.type) ||
            !prerequisite.data?.asset?.url
          );
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
    const totalGenerations = order.filter(id =>
      ['generateImage', 'generateVideo'].includes(nodeById(id)?.type),
    ).length;
    for (const id of order) {
      if (abortController.signal.aborted)
        throw new DOMException('Generation stopped by user.', 'AbortError');
      const n = nodeById(id);
      if (!n) continue;
      if (n.type === 'imageResize') {
        const source = sourceFor(getIncoming(n.id, 'image')[0]);
        const url = source?.data?.localDataUrl || source?.data?.asset?.url;
        if (!url) {
          setRunStatus('Image Resize is waiting for an input image.', 'warn');
          continue;
        }
        const image = await loadImage(url),
          canvas = document.createElement('canvas');
        drawResized(image, canvas, n.data);
        const resized = canvas.toDataURL('image/png');
        n.data.asset = {
          id: uid('asset'),
          kind: 'image',
          url: resized,
          name: `Resized ${n.data.width}×${n.data.height}`,
          width: canvas.width,
          height: canvas.height,
          sourceNodeId: n.id,
        };
        state.edges
          .filter(e => e.source === n.id)
          .forEach(e => {
            const target = nodeById(e.target);
            if (target?.type === 'preview') target.data.asset = n.data.asset;
          });
        render();
        continue;
      }
      if (['generateImage', 'generateVideo'].includes(n.type)) {
        const isVideo = n.type === 'generateVideo';
        generationStep++;
        const prompt = resolvePrompt(n.id);
        if (!String(prompt).trim())
          throw new Error(
            `${nodeDefs[n.type].title} ${n.id}: connect a Prompt, Text Append, or Text Merge node first.`,
          );
        const negativePrompt = resolveNegativePrompt(n.id);
        const continuityPrevious = isVideo && n.data.continuity ? timelinePredecessor(n.id) : null,
          continuityStartFrame = continuityPrevious?.data?.endFrame?.url
            ? continuityPrevious.data.endFrame
            : null;
        if (isVideo && n.data.continuity && !continuityStartFrame)
          throw new Error(
            `End-frame continuity for ${n.id} needs the previous Timeline clip to be generated successfully with an extractable final frame. Put clips in order and run the previous clip first.`,
          );
        const referenceImages = resolveReferences(n.id);
        state.activeGenerationId = n.id;
        n.data.status = 'running';
        n.data.error = '';
        n.data.asset = null;
        n.data.endFrame = null;
        state.edges
          .filter(edge => edge.source === n.id)
          .forEach(edge => {
            const target = nodeById(edge.target);
            if (target?.type === 'preview') target.data.asset = null;
          });
        render();
        setRunStatus(
          `${targetId ? 'Selected node' : `Generation ${generationStep}/${totalGenerations}`} · generating ${isVideo ? 'video' : 'image'}: ${n.id}`,
          'warn',
        );
        try {
          const sizeInstruction = `Output aspect ratio: ${n.data.size}. Match this frame shape exactly. ${n.data.size === '16:9' ? 'Use a wide landscape composition.' : n.data.size === '9:16' ? 'Use a tall portrait composition.' : n.data.size === '1:1' ? 'Use a square composition.' : n.data.size === '4:3' ? 'Use a standard landscape composition.' : 'Use a standard portrait composition.'}`;
          const continuityInstruction = continuityStartFrame
            ? 'CONTINUITY LOCK: Attached image 1 is the exact final frame of the previous Timeline clip. Use image 1 as the exact first frame of this video: preserve its subject identity, pose, position, camera angle, crop, lighting, and background. Continue motion naturally from that precise moment. No reset, jump, flash, dissolve, or scene change at the start.'
            : '';
          const audioRequirement = isVideo
            ? 'AUDIO IS REQUIRED: Return a video with audible, synchronized sound; do not make a silent clip. Follow the requested audio direction and make its music and sound effects clearly audible. Do not add spoken dialogue unless the prompt asks for it.'
            : '';
          const fidelityInstruction =
            isVideo && again
              ? '\n\nPROMPT FIDELITY: Follow the provided prompt closely and depict its requested characters, actions, setting, sequence, mood, and visual details. Keep the main action clear and recognizable throughout the clip. Do not substitute a different scene, omit requested actions, or add unrelated events. Use the connected reference images to preserve subject identity and appearance.'
              : '';
          const musePrompt = isVideo
            ? `Create a ${n.data.size} aspect ratio video clip, ${n.data.duration} seconds long. ${sizeInstruction}\n\n${audioRequirement}${continuityInstruction ? `\n\n${continuityInstruction}` : ''}${referenceImages.length ? `\n\nUse the attached reference image${referenceImages.length === 1 ? '' : 's'} as visual guidance${continuityStartFrame ? ' while keeping image 1 as the exact opening frame.' : '.'}` : ''}\n\nPrompt: ${prompt}${negativePrompt ? `\n\nAvoid: ${negativePrompt}` : ''}${fidelityInstruction}`
            : `${prompt}${referenceImages.length ? '\n\nUse the attached reference image' + (referenceImages.length === 1 ? '' : 's') + ' as visual guidance; follow the prompt while preserving relevant subject details.' : ''}\n\n${sizeInstruction}${negativePrompt ? `\n\nAvoid the following (negative prompt): ${negativePrompt}` : ''}`;
          const generationRequest = {
            type: 'MUSEFLOW_GENERATE',
            requestId: uid('generation'),
            prompt: musePrompt,
            negativePrompt,
            size: n.data.size,
            model: n.data.model,
            duration: n.data.duration,
            mediaType: isVideo ? 'video' : 'image',
            referenceImages: referenceImages.map(item => item.url),
            timeoutSec: 600,
          };
          state.generationRequestId = generationRequest.requestId;
          let reply = await museTabMessage(generationRequest, preferredMuseTabId, abortController.signal);
          if (abortController.signal.aborted)
            throw new DOMException('Generation stopped by user.', 'AbortError');
          if (!reply?.ok && reply?.code === 'SCENE_REFUSED') {
            setRunStatus(
              `Muse could not create ${n.data.sceneLabel || 'this scene'}; retrying once with a close, safe alternative…`,
              'warn',
            );
            const retryRequest = {
              ...generationRequest,
              prompt: `${musePrompt}\n\nSAFE EQUIVALENT RETRY: The previous version could not be generated. Create a close, allowed alternative for the same scene now. Stay faithful to the script's story purpose, characters, relationship, setting, action, mood, visual style, framing, continuity, and requested duration/aspect ratio. Change only the specific detail that prevents generation, replacing it with the nearest safe equivalent. Keep this scene in the story; do not skip it or change what it needs to accomplish. Do not ask a follow-up question or ask permission; generate the alternative in this attempt. Follow all content and safety rules.`,
            };
            reply = await museTabMessage(retryRequest, preferredMuseTabId, abortController.signal);
          }
          if (abortController.signal.aborted)
            throw new DOMException('Generation stopped by user.', 'AbortError');
          if (!reply?.ok)
            throw new Error(
              reply?.error || `Muse.ai did not return a generated ${isVideo ? 'video' : 'image'}.`,
            );
          const kind = isVideo ? 'video' : 'image';
          const url = isVideo ? reply.url : await persistImage(reply.url);
          if (!url) throw new Error(`Muse.ai returned an empty ${kind} attachment.`);
          const intrinsic = await mediaDimensions(url, isVideo ? 'video' : 'image');
          const actualRatio = intrinsic.width && intrinsic.height ? intrinsic.width / intrinsic.height : 0;
          const expectedRatio = ratioValue(n.data.size);
          const sizeMismatch = actualRatio && Math.abs(Math.log(actualRatio / expectedRatio)) > 0.09;
          if (sizeMismatch)
            throw new Error(
              `Muse returned ${intrinsic.width} × ${intrinsic.height}, which does not match the requested ${n.data.size} aspect ratio. The old result was cleared; retry generation after checking the Muse output.`,
            );
          n.data.asset = {
            id: uid('asset'),
            kind,
            url,
            name: `${isVideo ? 'Video' : 'Image'} ${n.id}`,
            sourceNodeId: n.id,
            width: intrinsic.width,
            height: intrinsic.height,
            requestedSize: n.data.size,
            sizeMismatch,
          };
          n.data.status = 'success';
          if (isVideo) n.data.endFrame = await extractVideoEndFrame(url);
          if (sizeMismatch)
            n.data.error = `Requested ${n.data.size}, received ${intrinsic.width}×${intrinsic.height}. Muse returned a different aspect ratio.`;
          state.edges
            .filter(e => e.source === n.id)
            .forEach(e => {
              const target = nodeById(e.target);
              if (target?.type === 'preview')
                target.data.asset = e.sourcePort === 'endFrame' ? n.data.endFrame : n.data.asset;
            });
          render();
        } catch (err) {
          if (err?.name === 'AbortError' || abortController.signal.aborted) {
            n.data.status = 'stopped';
            n.data.error = 'Generation stopped by user.';
            render();
            throw new DOMException('Generation stopped by user.', 'AbortError');
          }
          n.data.status = 'error';
          n.data.error = err?.message || String(err);
          render();
          throw err;
        }
      }
    }
    try {
      clearTimeout(autoSaveTimer);
      await queueWorkflowSave();
      setRunStatus(targetId ? 'Node generation completed.' : 'Workflow completed.', 'ok');
    } catch (saveError) {
      setRunStatus(
        `Generation completed, but workflow could not be saved: ${saveError?.message || String(saveError)}`,
        'warn',
      );
    }
  } catch (err) {
    if (err?.name === 'AbortError' || abortController.signal.aborted) {
      const active = state.nodes.find(n => n.id === state.activeGenerationId);
      if (active && active.data.status === 'running') {
        active.data.status = 'stopped';
        active.data.error = 'Generation stopped by user.';
        render();
      }
      try {
        clearTimeout(autoSaveTimer);
        await queueWorkflowSave();
      } catch {}
      return;
    }
    const failed = state.nodes.find(
      n => ['generateImage', 'generateVideo'].includes(n.type) && n.data.status === 'running',
    );
    if (failed) {
      failed.data.status = 'error';
      failed.data.error = err?.message || String(err);
      render();
    }
    const message = err?.message || String(err);
    setRunStatus(
      /failed to fetch/i.test(message)
        ? 'Muse connection failed. Reload MuseFlow 0.5.0, then check the Muse session.'
        : 'MuseFlow 0.5.0 · ' + message,
      'error',
    );
    try {
      clearTimeout(autoSaveTimer);
      await queueWorkflowSave();
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
