import { state } from '../core/state.js';
import { nodeById, getIncoming, sourceFor } from '../core/graph.js';
import { createSilentWav } from '../core/media-math.js';
import {
  TIMELINE_OUTPUT,
  canJoinWithoutReencode,
  buildConcatList,
  buildConcatCopyArgs,
  buildEncodeArgs,
  clipLengthForVoices,
  scheduleVoices,
} from '../core/ffmpeg-plan.js';
import { $, setRunStatus } from './dom.js';
import { ensureDockTimeline, closeTimelinePreview, visibleTimelineClipOrder } from './timeline.js';

async function loadClipVoiceovers(ffmpeg, clips, clipInfo, signal) {
  let voiced = 0;
  for (let index = 0; index < clips.length; index++) {
    const assets = getIncoming(clips[index].id, 'voice')
      .map(edge => sourceFor(edge)?.data?.asset)
      .filter(asset => asset?.url);
    if (!assets.length) continue;
    const durations = assets.map(asset => Number(asset.duration) || 0);
    const { offsets } = scheduleVoices(durations);
    clipInfo[index].voices = [];
    for (const [order, asset] of assets.entries()) {
      const response = await fetch(asset.url, { signal });
      if (!response.ok) throw new Error(`Could not read voiceover ${order + 1} for clip ${index + 1}.`);
      const path = `/voice_${String(index).padStart(3, '0')}_${order}.bin`;
      await ffmpeg.writeFile(path, new Uint8Array(await response.arrayBuffer()), { signal });
      clipInfo[index].voices.push({ path, offset: offsets[order] });
    }
    clipInfo[index].duration = clipLengthForVoices(clipInfo[index].duration, durations);
    voiced += assets.length;
  }
  return voiced;
}

async function loadTimelineMusic(ffmpeg, node, signal) {
  const music = node.data.music;
  if (!music?.url) return null;
  const response = await fetch(music.url, { signal });
  if (!response.ok) throw new Error(`Could not read the background music (HTTP ${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error('The background music file is empty.');
  const path = '/timeline-music.bin';
  await ffmpeg.writeFile(path, bytes, { signal });
  return { path, volume: music.volume };
}

export async function exportTimelineMp4WithFFmpeg(node, clips, button, formatSelect, fileName = '') {
  let exported = false;
  const stopButton = $('#timelineExportStopBtn'),
    abortController = new AbortController(),
    signal = abortController.signal,
    sourceUrls = [],
    ffmpeg = new window.FFmpegWASM.FFmpeg(),
    logs = [];
  state.timelineExporting = true;
  state.timelineExportAbortController = abortController;
  state.timelineFFmpeg = ffmpeg;
  button.disabled = true;
  formatSelect.disabled = true;
  stopButton.classList.remove('hidden');
  const throwIfStopped = () => {
    if (signal.aborted) throw new DOMException('Timeline export stopped.', 'AbortError');
  };
  const onLog = event => {
      if (event?.message) {
        logs.push(event.message);
        if (logs.length > 30) logs.shift();
      }
    },
    onProgress = event => {
      if (!signal.aborted && Number.isFinite(event?.progress)) {
        button.textContent = `Encoding ${Math.max(0, Math.min(99, Math.round(event.progress * 100)))}%…`;
        setRunStatus(
          `Encoding MP4 with FFmpeg · ${Math.max(0, Math.min(99, Math.round(event.progress * 100)))}%`,
          'warn',
        );
      }
    };
  try {
    ffmpeg.on('log', onLog);
    ffmpeg.on('progress', onProgress);
    button.textContent = 'Loading FFmpeg…';
    setRunStatus('Loading the local FFmpeg video engine…', 'warn');
    // The bundled UMD wrapper uses importScripts() to load the core, so let
    // it create a classic worker instead of forcing the module class worker.
    await ffmpeg.load(
      {
        coreURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.wasm'),
      },
      { signal },
    );
    const clipInfo = [];
    for (let index = 0; index < clips.length; index++) {
      throwIfStopped();
      button.textContent = `Loading clips ${index + 1}/${clips.length}…`;
      setRunStatus(`Loading timeline clip ${index + 1}/${clips.length} into local FFmpeg…`, 'warn');
      const response = await fetch(clips[index].data.asset.url, { credentials: 'include', signal });
      if (!response.ok)
        throw new Error(`Could not download timeline clip ${index + 1} (HTTP ${response.status}).`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length) throw new Error(`Timeline clip ${index + 1} is empty.`);
      const inputPath = `/scene_${String(index).padStart(3, '0')}.bin`;
      await ffmpeg.writeFile(inputPath, bytes, { signal });
      sourceUrls.push(inputPath);
      const probePath = `/probe_${index}.json`;
      await ffmpeg.ffprobe(
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_type,codec_name,width,height,profile,pix_fmt,sample_rate,channels:format=duration',
          '-of',
          'json',
          inputPath,
          '-o',
          probePath,
        ],
        -1,
        { signal },
      );
      const raw = await ffmpeg.readFile(probePath, 'utf8', { signal }),
        probe = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
      const videoStream = probe.streams?.find(stream => stream.codec_type === 'video'),
        audioStream = probe.streams?.find(stream => stream.codec_type === 'audio');
      if (!videoStream) throw new Error(`Timeline clip ${index + 1} has no readable video stream.`);
      clipInfo.push({
        hasAudio: !!audioStream,
        width: Number(videoStream.width) || 1280,
        height: Number(videoStream.height) || 720,
        videoCodec: videoStream.codec_name,
        videoProfile: videoStream.profile,
        pixelFormat: videoStream.pix_fmt,
        audioCodec: audioStream?.codec_name,
        audioRate: Number(audioStream?.sample_rate) || 0,
        audioChannels: Number(audioStream?.channels) || 0,
        sourceDuration: Number(probe.format?.duration) || 0,
        duration: Math.max(
          1,
          Math.min(60, Number(node.data.durations?.[clips[index].id] || clips[index].data.duration || 5)),
        ),
      });
      await ffmpeg.deleteFile(probePath, { signal });
    }
    throwIfStopped();
    const failure = exitCode =>
      new Error(
        logs
          .slice(-5)
          .map(item => item.trim())
          .filter(Boolean)
          .join(' ') || `FFmpeg exited with code ${exitCode}.`,
      );
    const voiced = await loadClipVoiceovers(ffmpeg, clips, clipInfo, signal);
    if (voiced)
      setRunStatus(`Mixing ${voiced} voiceover${voiced === 1 ? '' : 's'} into the timeline…`, 'warn');
    const music = await loadTimelineMusic(ffmpeg, node, signal);
    if (canJoinWithoutReencode(clipInfo, { hasMusic: Boolean(music), transition: node.data.transition })) {
      const concatFile = '/timeline-inputs.txt';
      await ffmpeg.writeFile(concatFile, new TextEncoder().encode(buildConcatList(sourceUrls)), { signal });
      button.textContent = 'Joining MP4 clips…';
      setRunStatus('Joining compatible timeline clips without re-encoding (fast, original quality)…', 'warn');
      const exitCode = await ffmpeg.exec(buildConcatCopyArgs(concatFile), -1, { signal });
      if (exitCode !== 0) throw failure(exitCode);
    } else {
      const silentInput = '/timeline-silence.wav';
      if (clipInfo.some(item => !item.hasAudio))
        await ffmpeg.writeFile(silentInput, createSilentWav(), { signal });
      const args = buildEncodeArgs({
        clipInfo,
        inputPaths: sourceUrls,
        silentInput,
        music,
        transition: node.data.transition,
      });
      button.textContent = 'Encoding MP4…';
      setRunStatus(
        `FFmpeg is assembling${music ? ' and mixing background music into' : ' and encoding'} the complete timeline locally…`,
        'warn',
      );
      const exitCode = await ffmpeg.exec(args, -1, { signal });
      if (exitCode !== 0) throw failure(exitCode);
    }
    throwIfStopped();
    const output = await ffmpeg.readFile(TIMELINE_OUTPUT, 'binary', { signal });
    if (!(output instanceof Uint8Array) || !output.length)
      throw new Error('FFmpeg produced an empty MP4 file.');
    if (state.timelineExportUrl) URL.revokeObjectURL(state.timelineExportUrl);
    state.timelineExportUrl = URL.createObjectURL(new Blob([output], { type: 'video/mp4' }));
    const player = $('#timelinePlayer'),
      nextPlayer = $('#timelinePlayerNext');
    closeTimelinePreview();
    $('#timelinePreviewPanel').classList.remove('hidden');
    nextPlayer.pause();
    nextPlayer.classList.remove('is-active', 'is-fading');
    nextPlayer.controls = false;
    player.src = state.timelineExportUrl;
    player.controls = true;
    player.classList.remove('is-fading');
    player.classList.add('is-active');
    const link = document.createElement('a');
    link.href = state.timelineExportUrl;
    link.download = `${fileName || `Museta-Timeline-${new Date().toISOString().replace(/[:.]/g, '-')}`}.mp4`;
    link.click();
    exported = true;
    setRunStatus('Timeline exported as MP4 (H.264) with local FFmpeg.', 'ok');
  } catch (error) {
    if (error?.name === 'AbortError' || signal.aborted) setRunStatus('Timeline export stopped.', 'warn');
    else setRunStatus(`Timeline export failed: ${error?.message || String(error)}`, 'error');
  } finally {
    ffmpeg.off('log', onLog);
    ffmpeg.off('progress', onProgress);
    ffmpeg.terminate();
    state.timelineFFmpeg = null;
    state.timelineExportAbortController = null;
    state.timelineExporting = false;
    button.disabled = false;
    formatSelect.disabled = false;
    button.textContent = '⇩ Export';
    stopButton.classList.add('hidden');
  }
  return exported;
}

export async function exportTimelineVideo({ format = '', fileName = '' } = {}) {
  if (state.timelineExporting) return false;
  let exported = false;
  const node = ensureDockTimeline(),
    clips = visibleTimelineClipOrder(node)
      .map(id => nodeById(id))
      .filter(clip => clip?.type === 'generateVideo' && clip.data?.asset?.url),
    button = $('#timelineExportBtn'),
    formatSelect = $('#timelineExportFormat'),
    requestedFormat = format || formatSelect.value;
  if (!clips.length) {
    setRunStatus('Add completed video clips to the Timeline before exporting.', 'warn');
    return false;
  }
  if (requestedFormat === 'mp4') {
    if (!window.FFmpegWASM?.FFmpeg) {
      setRunStatus(
        'The bundled FFmpeg engine could not be loaded. Reload the extension and try again.',
        'error',
      );
      return false;
    }
    return exportTimelineMp4WithFFmpeg(node, clips, button, formatSelect, fileName);
  }
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    setRunStatus('This browser cannot export a stitched video from the Timeline.', 'error');
    return false;
  }
  state.timelineExporting = true;
  state.timelineExportAbortController = new AbortController();
  const exportSignal = state.timelineExportAbortController.signal,
    stopButton = $('#timelineExportStopBtn');
  button.disabled = true;
  formatSelect.disabled = true;
  stopButton.classList.remove('hidden');
  const sourceUrls = [];
  let recorder = null,
    canvasStream = null,
    audioContext = null,
    audioSource = null,
    audioDestination = null,
    audioResumePromise = Promise.resolve(),
    musicElement = null,
    video = null,
    frameRequest = 0,
    frameTimer = 0,
    recordingPromise = null,
    recorderMimeType = '';
  const throwIfStopped = () => {
    if (exportSignal.aborted) throw new DOMException('Timeline export stopped.', 'AbortError');
  };
  const waitForExportDelay = duration =>
    new Promise((resolve, reject) => {
      throwIfStopped();
      const timer = setTimeout(() => {
          exportSignal.removeEventListener('abort', cancel);
          resolve();
        }, duration),
        cancel = () => {
          clearTimeout(timer);
          reject(new DOMException('Timeline export stopped.', 'AbortError'));
        };
      exportSignal.addEventListener('abort', cancel, { once: true });
    });
  try {
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    if (AudioContextType) {
      audioContext = new AudioContextType();
      audioDestination = audioContext.createMediaStreamDestination();
      audioResumePromise = audioContext.resume().catch(() => {});
    }
  } catch {
    audioContext = null;
    audioDestination = null;
  }
  try {
    for (let index = 0; index < clips.length; index++) {
      throwIfStopped();
      button.textContent = `Preparing ${index + 1}/${clips.length}…`;
      setRunStatus(`Preparing timeline clip ${index + 1}/${clips.length} for export…`, 'warn');
      const response = await fetch(clips[index].data.asset.url, {
        credentials: 'include',
        signal: exportSignal,
      });
      if (!response.ok)
        throw new Error(`Could not download timeline clip ${index + 1} (HTTP ${response.status}).`);
      const blob = await response.blob();
      if (!blob.size) throw new Error(`Timeline clip ${index + 1} is empty.`);
      sourceUrls.push(URL.createObjectURL(blob));
    }
    video = document.createElement('video');
    video.preload = 'auto';
    video.playsInline = true;
    video.muted = false;
    video.style.cssText =
      'position:fixed;width:2px;height:2px;left:-4px;bottom:0;opacity:.01;pointer-events:none';
    document.body.appendChild(video);
    const waitForData = () =>
      new Promise((resolve, reject) => {
        if (exportSignal.aborted) {
          reject(new DOMException('Timeline export stopped.', 'AbortError'));
          return;
        }
        if (video.readyState >= 2) {
          resolve();
          return;
        }
        let timer = setTimeout(() => {
          cleanup();
          reject(new Error('Video decoding timed out.'));
        }, 20000);
        const ready = () => {
            cleanup();
            resolve();
          },
          failed = () => {
            cleanup();
            reject(new Error('The video file could not be decoded.'));
          },
          cancel = () => {
            cleanup();
            reject(new DOMException('Timeline export stopped.', 'AbortError'));
          },
          cleanup = () => {
            clearTimeout(timer);
            video.removeEventListener('loadeddata', ready);
            video.removeEventListener('error', failed);
            exportSignal.removeEventListener('abort', cancel);
          };
        video.addEventListener('loadeddata', ready, { once: true });
        video.addEventListener('error', failed, { once: true });
        exportSignal.addEventListener('abort', cancel, { once: true });
      });
    video.src = sourceUrls[0];
    video.load();
    await waitForData();
    const originalWidth = video.videoWidth || 1280,
      originalHeight = video.videoHeight || 720,
      scale = Math.min(1, 1280 / Math.max(originalWidth, originalHeight)),
      canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.floor((originalWidth * scale) / 2) * 2);
    canvas.height = Math.max(2, Math.floor((originalHeight * scale) / 2) * 2);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Could not create the video export canvas.');
    const exportFps = 20;
    const drawFrame = () => {
      if (!video || !context) return;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const fit = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight),
          width = video.videoWidth * fit,
          height = video.videoHeight * fit;
        context.fillStyle = '#000';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      }
      frameTimer = setTimeout(drawFrame, 1000 / exportFps);
    };
    drawFrame();
    canvasStream = canvas.captureStream(exportFps);
    if (audioContext && audioDestination) {
      try {
        audioSource = audioContext.createMediaElementSource(video);
        audioSource.connect(audioDestination);
        const audioTrack = audioDestination.stream.getAudioTracks()[0];
        if (audioTrack) canvasStream.addTrack(audioTrack);
        if (node.data.music?.url) {
          musicElement = new Audio(node.data.music.url);
          musicElement.loop = true;
          const musicGain = audioContext.createGain();
          musicGain.gain.value = Math.max(0, Math.min(1, Number(node.data.music.volume ?? 0.35)));
          audioContext.createMediaElementSource(musicElement).connect(musicGain).connect(audioDestination);
        }
        await audioResumePromise;
        if (audioContext.state !== 'running') await audioContext.resume();
      } catch {
        audioContext.close().catch(() => {});
        audioContext = null;
        audioDestination = null;
        audioSource = null;
      }
    }
    if (!audioDestination && typeof video.captureStream === 'function') {
      const captured = video.captureStream();
      for (const track of captured.getAudioTracks()) canvasStream.addTrack(track);
    }
    const mimeTypes =
      requestedFormat === 'mp4'
        ? [
            'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
            'video/mp4;codecs="avc1.424028,mp4a.40.2"',
            'video/mp4;codecs=avc1,mp4a.40.2',
            'video/mp4;codecs=avc1',
            'video/mp4',
          ]
        : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    recorderMimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported?.(type)) || '';
    if (requestedFormat === 'mp4' && !recorderMimeType)
      throw new Error(
        'This browser cannot encode MP4 (H.264). Choose WebM, or use a browser with MP4 MediaRecorder support.',
      );
    const recorderOptions = {
      videoBitsPerSecond:
        requestedFormat === 'mp4'
          ? Math.round(
              Math.min(9_000_000, Math.max(6_000_000, canvas.width * canvas.height * exportFps * 0.28)),
            )
          : undefined,
      audioBitsPerSecond: 192_000,
    };
    if (recorderMimeType) recorderOptions.mimeType = recorderMimeType;
    recorder = new MediaRecorder(canvasStream, recorderOptions);
    const chunks = [];
    recordingPromise = new Promise((resolve, reject) => {
      recorder.ondataavailable = event => {
        if (event.data?.size) chunks.push(event.data);
      };
      recorder.onerror = event => reject(event.error || new Error('Video encoding failed.'));
      recorder.onstop = () =>
        resolve(new Blob(chunks, { type: recorder.mimeType || recorderMimeType || 'video/webm' }));
    });
    recordingPromise.catch(() => {});
    recorder.start(1000);
    await musicElement?.play().catch(() => {});
    for (let index = 0; index < clips.length; index++) {
      throwIfStopped();
      if (index) {
        if (recorder.state === 'recording') recorder.pause();
        video.pause();
        video.src = sourceUrls[index];
        video.load();
        await waitForData();
      }
      video.currentTime = 0;
      await video.play();
      if (index) {
        await waitForExportDelay(60);
        if (recorder.state === 'paused') recorder.resume();
      }
      button.textContent = `Exporting ${index + 1}/${clips.length}…`;
      setRunStatus(`Exporting timeline clip ${index + 1}/${clips.length} in track order…`, 'warn');
      const duration = Math.max(
        1,
        Math.min(60, Number(node.data.durations?.[clips[index].id] || clips[index].data.duration || 5)),
      );
      await waitForExportDelay(duration * 1000);
      video.pause();
    }
    const completed = new Promise(resolve => {
      recorder.addEventListener('stop', resolve, { once: true });
    });
    recorder.stop();
    await completed;
    const output = await recordingPromise;
    if (!output.size) throw new Error('The exported video is empty.');
    const actualMime = (output.type || recorder.mimeType || recorderMimeType || 'video/webm').toLowerCase(),
      extension = actualMime.includes('mp4') ? 'mp4' : 'webm';
    if (requestedFormat === 'mp4' && extension !== 'mp4')
      throw new Error(
        'The browser did not produce an MP4 file. Choose WebM or use a browser with MP4 MediaRecorder support.',
      );
    if (state.timelineExportUrl) URL.revokeObjectURL(state.timelineExportUrl);
    state.timelineExportUrl = URL.createObjectURL(output);
    const player = $('#timelinePlayer'),
      nextPlayer = $('#timelinePlayerNext');
    closeTimelinePreview();
    $('#timelinePreviewPanel').classList.remove('hidden');
    nextPlayer.pause();
    nextPlayer.classList.remove('is-active', 'is-fading');
    nextPlayer.controls = false;
    player.src = state.timelineExportUrl;
    player.controls = true;
    player.classList.remove('is-fading');
    player.classList.add('is-active');
    const link = document.createElement('a');
    link.href = state.timelineExportUrl;
    link.download = `${fileName || `Museta-Timeline-${new Date().toISOString().replace(/[:.]/g, '-')}`}.${extension}`;
    link.click();
    exported = true;
    const transitionNote =
      (node.data.transition?.type || 'cut') !== 'cut' ? ' Transitions are applied in MP4 export only.' : '';
    setRunStatus(`Stitched timeline exported as ${extension.toUpperCase()}.${transitionNote}`, 'ok');
  } catch (error) {
    if (error?.name === 'AbortError') setRunStatus('Timeline export stopped.', 'warn');
    else setRunStatus(`Timeline export failed: ${error?.message || String(error)}`, 'error');
  } finally {
    if (frameRequest) cancelAnimationFrame(frameRequest);
    clearTimeout(frameTimer);
    if (recorder?.state === 'recording' || recorder?.state === 'paused') {
      recorder.stop();
      try {
        await recordingPromise;
      } catch {}
    }
    musicElement?.pause();
    video?.pause();
    video?.remove();
    canvasStream?.getTracks().forEach(track => track.stop());
    await audioContext?.close().catch(() => {});
    sourceUrls.forEach(url => URL.revokeObjectURL(url));
    state.timelineExporting = false;
    state.timelineExportAbortController = null;
    button.disabled = false;
    formatSelect.disabled = false;
    button.textContent = '⇩ Export';
    stopButton.classList.add('hidden');
  }
  return exported;
}

export function stopTimelineExport() {
  if (!state.timelineExporting) return;
  state.timelineExportAbortController?.abort();
  state.timelineFFmpeg?.terminate();
  setRunStatus('Stopping timeline export…', 'warn');
}
