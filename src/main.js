import { initStudio } from './app/studio.js';
import { initBatch } from './app/batch.js';
import { initRunPanel } from './app/run-panel.js';
import { getTtsApiKey, setTtsApiKey } from './app/tts-client.js';
import { APP_VERSION } from './app/app-info.js';
import { state } from './core/state.js';
import { parseSceneScript } from './core/scene-script.js';
import { $, canvas, edgesSvg, setRunStatus } from './app/dom.js';
import {
  scheduleAutoSave,
  saveState,
  exportWorkflowFile,
  importWorkflowFile,
  loadState,
  resetState,
  syncSettingsUI,
  readSettingsUI,
} from './app/persistence.js';
import {
  createUndoSnapshot,
  undoLastChange,
  trackUndoEdit,
  isUndoTrackedTarget,
  forgetUndoInput,
  deferToNativeUndo,
  releaseNativeUndo,
} from './app/undo.js';
import { addNode, addTextNote, removeSelectedNodes, buildSceneNodesFromScript } from './app/editor.js';
import { runConnectionChoice, onWireMove, onWireUp } from './app/connections.js';
import { drawEdges, render, moveTextNote, finishTextNoteMove } from './app/render.js';
import {
  applyCanvasTransform,
  zoomAt,
  setZoom,
  fitCanvas,
  startPan,
  movePan,
  endPan,
  startSelectionMarquee,
  moveSelectionMarquee,
  endSelectionMarquee,
  moveGroupMarquee,
  finishGroupMarquee,
  cancelGroupMarquee,
  setGroupDrawMode,
} from './app/viewport.js';
import {
  openCanvasMenu,
  openEdgeMenu,
  selectEdgePointer,
  closeCanvasMenu,
  runCanvasAction,
} from './app/menus.js';
import {
  ensureDockTimeline,
  importAllVideosToTimeline,
  toggleTimelineOutputMenu,
  toggleTimeline,
  closeTimelinePreview,
  playTimeline,
  setTimelineMusic,
  setTimelineMusicVolume,
  removeTimelineMusic,
  setTimelineTransition,
} from './app/timeline.js';
import { exportTimelineVideo, stopTimelineExport } from './app/timeline-export.js';
import { testMuseSession, detectMuse } from './app/muse-client.js';
import { stopGeneration, onWorkflowRunButtonClick } from './app/runner.js';

document
  .querySelectorAll('[data-add]')
  .forEach(b => (b.onclick = () => (b.dataset.add === 'text' ? addTextNote() : addNode(b.dataset.add))));
$('#scriptImportBtn').onclick = () => {
  $('#scriptModal').classList.remove('hidden');
  $('#scriptImportStatus').textContent = '';
  $('#scriptInput').focus();
};
$('#cancelScriptImport').onclick = () => $('#scriptModal').classList.add('hidden');
$('#buildScriptNodes').onclick = buildSceneNodesFromScript;
$('#scriptModal').onclick = event => {
  if (event.target.id === 'scriptModal') $('#scriptModal').classList.add('hidden');
};
$('#scriptInput').addEventListener('input', () => {
  const count = parseSceneScript($('#scriptInput').value).length;
  $('#scriptImportStatus').className = '';
  $('#scriptImportStatus').textContent = count ? `${count} scene${count === 1 ? '' : 's'} detected.` : '';
});
$('#timelineToggleBtn').onclick = toggleTimeline;
$('#timelineExportBtn').onclick = exportTimelineVideo;
$('#timelineExportStopBtn').onclick = stopTimelineExport;
$('#timelineImportAllBtn').onclick = importAllVideosToTimeline;
$('#closeTimelinePreview').onclick = closeTimelinePreview;
$('#timelineAddVideoBtn').onclick = toggleTimelineOutputMenu;
$('#timelinePlayBtn').onclick = () => playTimeline(ensureDockTimeline());
$('#timelineMusicBtn').onclick = () => $('#timelineMusicInput').click();
$('#timelineMusicInput').onchange = event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  setTimelineMusic(file);
};
$('#timelineMusicVolume').oninput = event => setTimelineMusicVolume(event.target.value);
$('#timelineMusicRemove').onclick = removeTimelineMusic;
$('#timelineTransition').onchange = event => setTimelineTransition({ type: event.target.value });
$('#timelineTransitionDuration').onchange = event => setTimelineTransition({ duration: event.target.value });
// A DOM click handler receives the MouseEvent as its first argument. Keep
// Keep toolbar workflow execution separate from the per-node generation action.
$('#runBtn').onclick = onWorkflowRunButtonClick;
$('#saveBtn').onclick = saveState;
$('#resetBtn').onclick = resetState;
$('#workflowExportBtn').onclick = exportWorkflowFile;
$('#workflowImportBtn').onclick = () => $('#workflowFileInput').click();
$('#workflowFileInput').onchange = event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (file) void importWorkflowFile(file);
};
$('#settingsBtn').onclick = async () => {
  syncSettingsUI();
  $('#ttsApiKeySetting').placeholder = (await getTtsApiKey())
    ? 'Saved — paste a new key to replace it'
    : 'sk_tvoice_…';
  $('#settingsModal').classList.remove('hidden');
};
$('#buyCoffeeBtn').onclick = () => $('#donationModal').classList.remove('hidden');
$('#closeDonationBtn').onclick = () => $('#donationModal').classList.add('hidden');
$('#donationModal').onclick = event => {
  if (event.target.id === 'donationModal') $('#donationModal').classList.add('hidden');
};
$('#donationQrImage').onerror = () => {
  $('#donationQrImage').classList.add('hidden');
  $('#donationQrFallback').classList.remove('hidden');
};
$('#testMuseBtn').onclick = () => testMuseSession();
$('#closeSettingsBtn').onclick = () => $('#settingsModal').classList.add('hidden');
$('#saveSettingsBtn').onclick = async () => {
  readSettingsUI();
  const ttsKey = $('#ttsApiKeySetting').value.trim();
  if (ttsKey) await setTtsApiKey(ttsKey);
  $('#ttsApiKeySetting').value = '';
  $('#settingsModal').classList.add('hidden');
  await saveState();
};
$('#settingsModal').onclick = e => {
  if (e.target.id === 'settingsModal') $('#settingsModal').classList.add('hidden');
};
window.addEventListener('resize', drawEdges);
window.addEventListener('pointermove', onWireMove);
window.addEventListener('pointermove', moveSelectionMarquee);
window.addEventListener('pointermove', moveGroupMarquee);
window.addEventListener('pointermove', moveTextNote);
window.addEventListener('pointerup', onWireUp);
window.addEventListener('pointerup', endSelectionMarquee);
window.addEventListener('pointerup', finishGroupMarquee);
window.addEventListener('pointerup', finishTextNoteMove);
window.addEventListener('pointercancel', endSelectionMarquee);
window.addEventListener('pointercancel', cancelGroupMarquee);
window.addEventListener('pointercancel', finishTextNoteMove);
$('#viewport').addEventListener(
  'wheel',
  event => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    zoomAt(event.clientX, event.clientY, factor);
  },
  { passive: false },
);
$('#viewport').addEventListener('pointerdown', event => {
  const panGesture = event.button === 1 || state.spaceDown || state.handMode;
  if (
    panGesture &&
    !event.target.closest('button,input,label,textarea,select,video,a,.canvas-tools,.canvas-note')
  )
    startPan(event);
});
$('#viewport').addEventListener('pointerdown', startSelectionMarquee);
document.addEventListener(
  'pointerdown',
  event => {
    const stop = event.target.closest('[data-stop-generation]');
    if (!stop) return;
    if (event.pointerType === 'mouse' && event.detail > 1) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stopGeneration(stop.dataset.stopGeneration);
  },
  true,
);
window.addEventListener('pointermove', movePan);
window.addEventListener('pointerup', endPan);
window.addEventListener('pointercancel', endPan);
$('#handTool').onclick = () => {
  state.handMode = !state.handMode;
  applyCanvasTransform();
  $('#handTool').classList.toggle('active', state.handMode);
};
$('#groupTool').onclick = () => setGroupDrawMode(!state.groupDrawMode);
$('#zoomIn').onclick = () => setZoom(Math.min(2.5, state.zoom * 1.15));
$('#zoomOut').onclick = () => setZoom(Math.max(0.25, state.zoom / 1.15));
$('#fitCanvas').onclick = fitCanvas;
$('#viewport').addEventListener('contextmenu', openCanvasMenu);
document.addEventListener(
  'input',
  event => {
    trackUndoEdit(event);
    if (isUndoTrackedTarget(event.target)) scheduleAutoSave();
  },
  true,
);
document.addEventListener(
  'change',
  event => {
    trackUndoEdit(event);
    if (isUndoTrackedTarget(event.target)) scheduleAutoSave();
  },
  true,
);
document.addEventListener(
  'focusout',
  event => {
    forgetUndoInput(event.target);
  },
  true,
);
$('#canvasMenu').addEventListener('click', e => {
  const item = e.target.closest('[data-context-action]');
  if (!item) return;
  if (item.dataset.contextAction === 'connect-choice') runConnectionChoice(Number(item.dataset.choice));
  else runCanvasAction(item.dataset.contextAction);
});
edgesSvg.addEventListener('contextmenu', openEdgeMenu);
edgesSvg.addEventListener('pointerdown', selectEdgePointer);
canvas.addEventListener('contextmenu', openCanvasMenu);
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#canvasMenu')) {
    closeCanvasMenu();
    state.pendingConnection = null;
  }
});
const isTextEntry = target => Boolean(target?.closest?.('textarea,input,select,[contenteditable="true"]'));
const isTextEditor = target =>
  Boolean(
    target?.closest?.(
      'textarea,input:not([type="checkbox"]):not([type="number"]):not([type="file"]):not([type="range"]):not([type="color"]),[contenteditable="true"]',
    ),
  );
document.addEventListener(
  'keydown',
  e => {
    if (document.body.dataset.view === 'studio') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      if (isTextEditor(e.target)) {
        deferToNativeUndo(e.target);
        return;
      }
      e.preventDefault();
      undoLastChange();
      return;
    }
    if (e.code === 'Space' && !isTextEntry(e.target)) {
      // Space is a temporary canvas hand key. Prevent native activation of a
      // focused toolbar button (Run/Stop) on both press and release.
      e.preventDefault();
      if (!e.repeat) {
        state.spaceDown = true;
        applyCanvasTransform();
        if (document.activeElement?.matches?.('button')) document.activeElement.blur();
      }
      return;
    }
    if (e.key === 'Escape') {
      closeCanvasMenu();
      endSelectionMarquee();
      cancelGroupMarquee();
      $('#donationModal').classList.add('hidden');
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !isTextEntry(e.target)) {
      e.preventDefault();
      if (state.selectedEdgeIds.length) {
        const ids = new Set(state.selectedEdgeIds);
        createUndoSnapshot(`Delete ${ids.size} connection${ids.size === 1 ? '' : 's'}`);
        state.edges = state.edges.filter(edge => !ids.has(edge.id));
        state.selectedEdgeIds = [];
        render();
        saveState();
        setRunStatus('Selected connections deleted.', 'ok');
      } else removeSelectedNodes();
    }
    if (e.key.toLowerCase() === 'h' && !isTextEntry(e.target)) {
      state.handMode = !state.handMode;
      $('#handTool').classList.toggle('active', state.handMode);
      applyCanvasTransform();
    }
    if (
      !e.repeat &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !isTextEntry(e.target) &&
      e.key.toLowerCase() === 'g'
    ) {
      e.preventDefault();
      setGroupDrawMode(!state.groupDrawMode);
    }
    if (
      !e.repeat &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !isTextEntry(e.target) &&
      e.key.toLowerCase() === 't'
    ) {
      e.preventDefault();
      setGroupDrawMode(false);
      const rect = $('#viewport').getBoundingClientRect();
      addTextNote(
        (rect.width / 2 - state.panX) / state.zoom - 130,
        (rect.height / 2 - state.panY) / state.zoom - 80,
      );
    }
  },
  true,
);
document.addEventListener(
  'keyup',
  e => {
    if (e.key.toLowerCase() === 'z') releaseNativeUndo(e.target);
    if (e.code === 'Space' && !isTextEntry(e.target)) {
      e.preventDefault();
      state.spaceDown = false;
      applyCanvasTransform();
    }
  },
  true,
);
window.addEventListener('blur', () => {
  state.spaceDown = false;
  endPan();
  endSelectionMarquee();
  cancelGroupMarquee();
  applyCanvasTransform();
});

// Keep the session indicator fresh when Muse is opened/reloaded after the canvas.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && /^https:\/\/(?:[^/]+\.)?muse\.ai\//i.test(tab.url || ''))
    testMuseSession(tabId);
});
chrome.tabs.onCreated.addListener(tab => {
  if (/^https:\/\/(?:[^/]+\.)?muse\.ai\//i.test(tab.url || ''))
    setTimeout(() => testMuseSession(tab.id), 1200);
});

$('#brandVersion').textContent = APP_VERSION;
initRunPanel();
initBatch();
initStudio();
loadState();
detectMuse();
applyCanvasTransform();
