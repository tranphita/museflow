import { uid } from '../core/node-defs.js';
import { clampDimension } from '../core/media-math.js';

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Không tải được ảnh đã nối để đổi kích thước.'));
    image.src = url;
  });
}

export function drawResized(image, canvas, data = {}) {
  const width = clampDimension(data.width || 1024),
    height = clampDimension(data.height || 1024);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.fillStyle = '#101116';
  context.fillRect(0, 0, width, height);
  const fit = data.fit || 'cover';
  let scale =
    fit === 'stretch'
      ? null
      : fit === 'contain'
        ? Math.min(width / image.naturalWidth, height / image.naturalHeight)
        : Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = scale === null ? width : image.naturalWidth * scale,
    drawHeight = scale === null ? height : image.naturalHeight * scale;
  context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

export async function mediaDimensions(url, kind) {
  if (kind === 'image')
    return new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => resolve({ width: 0, height: 0 });
      image.src = url;
    });
  return new Promise(resolve => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => resolve({ width: video.videoWidth, height: video.videoHeight });
    video.onerror = () => resolve({ width: 0, height: 0 });
    video.src = url;
  });
}

export function extractVideoEndFrame(url) {
  return new Promise(resolve => {
    const video = document.createElement('video');
    if (/^https?:/i.test(url)) video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    let finished = false;
    const done = value => {
      if (finished) return;
      finished = true;
      video.removeAttribute('src');
      video.load();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 12000);
    let probingLength = false;
    const seekToEnd = () =>
      (video.currentTime = Math.max(0, video.duration - Math.min(0.04, video.duration / 100)));
    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration)) return seekToEnd();
      // Recorded WebM files carry no duration until the browser seeks past the end.
      probingLength = true;
      video.currentTime = 1e101;
    };
    video.onseeked = () => {
      if (probingLength) {
        probingLength = false;
        if (Number.isFinite(video.duration)) return seekToEnd();
        clearTimeout(timer);
        return done(null);
      }
      try {
        const width = video.videoWidth,
          height = video.videoHeight;
        if (!width || !height) {
          clearTimeout(timer);
          done(null);
          return;
        }
        const frame = document.createElement('canvas');
        frame.width = width;
        frame.height = height;
        frame.getContext('2d').drawImage(video, 0, 0, width, height);
        const dataUrl = frame.toDataURL('image/png');
        clearTimeout(timer);
        done({ id: uid('endframe'), kind: 'image', url: dataUrl, name: 'Khung cuối video', width, height });
      } catch {
        clearTimeout(timer);
        done(null);
      }
    };
    video.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    video.src = url;
    video.load();
  });
}

export async function persistImage(url) {
  if (!url) return '';
  if (url.startsWith('data:')) return url;
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (blob.size > 8 * 1024 * 1024) return url;
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return url;
  }
}

export function blobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Không đóng gói được media của workflow.'));
    reader.readAsDataURL(blob);
  });
}
