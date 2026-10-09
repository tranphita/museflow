export function createSilentWav() {
  const sampleRate = 48000,
    channels = 2,
    bitsPerSample = 16,
    dataBytes = sampleRate * channels * (bitsPerSample / 8),
    buffer = new ArrayBuffer(44 + dataBytes),
    view = new DataView(buffer),
    bytes = new Uint8Array(buffer);
  const write = (offset, value) => {
    for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  return bytes;
}

export function ratioValue(size) {
  const [w, h] = String(size || '1:1')
    .split(':')
    .map(Number);
  return w > 0 && h > 0 ? w / h : 1;
}

export function clampDimension(value) {
  return Math.max(1, Math.min(4096, Math.round(Number(value) || 1)));
}
