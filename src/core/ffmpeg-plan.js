export const TIMELINE_OUTPUT = '/museta-timeline.mp4';
const MUSIC_FADE_SECONDS = 1.5;

export function canJoinWithoutReencode(clipInfo, { hasMusic = false } = {}) {
  if (hasMusic || !clipInfo.length) return false;
  const first = clipInfo[0];
  return clipInfo.every(
    item =>
      item.videoCodec === 'h264' &&
      item.videoProfile === first.videoProfile &&
      item.pixelFormat === first.pixelFormat &&
      item.width === first.width &&
      item.height === first.height &&
      item.hasAudio &&
      item.audioCodec === 'aac' &&
      item.audioRate === first.audioRate &&
      item.audioChannels === first.audioChannels &&
      item.sourceDuration > 0 &&
      Math.abs(item.sourceDuration - item.duration) < 0.15,
  );
}

export function buildConcatCopyArgs(listPath) {
  return [
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    '-y',
    TIMELINE_OUTPUT,
  ];
}

export function buildConcatList(paths) {
  return paths.map(path => `file '${path}'`).join('\n') + '\n';
}

export function outputFrameSize(clipInfo, maxEdge = 1280) {
  const first = clipInfo[0];
  const scale = Math.min(1, maxEdge / Math.max(first.width, first.height));
  return {
    width: Math.max(2, Math.floor((first.width * scale) / 2) * 2),
    height: Math.max(2, Math.floor((first.height * scale) / 2) * 2),
  };
}

export function buildEncodeArgs({ clipInfo, inputPaths, silentInput, music = null }) {
  const { width, height } = outputFrameSize(clipInfo);
  const args = [];
  inputPaths.forEach(path => args.push('-i', path));
  let nextInput = inputPaths.length;
  const silentIndexes = new Map();
  clipInfo.forEach((item, index) => {
    if (item.hasAudio) return;
    silentIndexes.set(index, nextInput++);
    args.push('-stream_loop', '-1', '-i', silentInput);
  });
  const musicIndex = music ? nextInput++ : -1;
  if (music) args.push('-stream_loop', '-1', '-i', music.path);

  const filters = [],
    concatInputs = [];
  clipInfo.forEach((item, index) => {
    const duration = item.duration.toFixed(3);
    filters.push(
      `[${index}:v:0]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=24,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS[v${index}]`,
    );
    const audioSource = item.hasAudio ? `${index}:a:0` : `${silentIndexes.get(index)}:a:0`;
    filters.push(
      `[${audioSource}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad=pad_dur=${duration},atrim=duration=${duration}[a${index}]`,
    );
    concatInputs.push(`[v${index}][a${index}]`);
  });
  filters.push(`${concatInputs.join('')}concat=n=${clipInfo.length}:v=1:a=1[outv][clipa]`);

  let audioOut = '[clipa]';
  if (music) {
    const total = clipInfo.reduce((sum, item) => sum + item.duration, 0);
    const volume = Math.max(0, Math.min(1, Number(music.volume ?? 0.35)));
    const fadeStart = Math.max(0, total - MUSIC_FADE_SECONDS);
    filters.push(
      `[${musicIndex}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,atrim=duration=${total.toFixed(3)},volume=${volume.toFixed(2)},afade=t=out:st=${fadeStart.toFixed(3)}:d=${MUSIC_FADE_SECONDS}[music]`,
    );
    // amix halves each input; doubling restores the clip audio to its original level.
    filters.push('[clipa][music]amix=inputs=2:duration=first:dropout_transition=0,volume=2[mixa]');
    audioOut = '[mixa]';
  }

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[outv]',
    '-map',
    audioOut,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-movflags',
    '+faststart',
    '-max_muxing_queue_size',
    '1024',
    '-y',
    TIMELINE_OUTPUT,
  );
  return args;
}
