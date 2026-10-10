export const TIMELINE_OUTPUT = '/museta-timeline.mp4';
const MUSIC_FADE_SECONDS = 1.5;
const CLIP_AUDIO_UNDER_VOICE = 0.35;
const VOICE_LEAD_SECONDS = 0.2;
const VOICE_GAP_SECONDS = 0.35;
const VOICE_TAIL_SECONDS = 0.3;
const round2 = value => Math.round(value * 100) / 100;

export function scheduleVoices(voiceDurations) {
  const offsets = [];
  let cursor = VOICE_LEAD_SECONDS;
  for (const duration of voiceDurations) {
    offsets.push(round2(cursor));
    cursor += (Number(duration) || 0) + VOICE_GAP_SECONDS;
  }
  const length = voiceDurations.length ? round2(cursor - VOICE_GAP_SECONDS + VOICE_TAIL_SECONDS) : 0;
  return { offsets, length };
}

export function clipLengthForVoices(duration, voiceDurations) {
  return Math.min(60, Math.max(duration, scheduleVoices(voiceDurations).length));
}

export const TRANSITIONS = Object.freeze({
  cut: 'Cut',
  fade: 'Crossfade',
  fadeblack: 'Fade through black',
  dissolve: 'Dissolve',
  smoothleft: 'Slide left',
});
const MAX_TRANSITION_SECONDS = 2;

export function normalizeTransition(transition, durations) {
  const type = Object.hasOwn(TRANSITIONS, transition?.type) ? transition.type : 'cut';
  if (type === 'cut' || durations.length < 2) return { type: 'cut', duration: 0 };
  const limit = Math.min(MAX_TRANSITION_SECONDS, Math.min(...durations) / 2);
  const duration = Math.max(0.1, Math.min(limit, Number(transition.duration) || 0.5));
  return { type, duration: Math.round(duration * 100) / 100 };
}

export function timelineLength(durations, transition) {
  const total = durations.reduce((sum, value) => sum + value, 0);
  return total - normalizeTransition(transition, durations).duration * Math.max(0, durations.length - 1);
}

export function canJoinWithoutReencode(
  clipInfo,
  { hasMusic = false, transition = null, hasSubtitles = false, clipAudio = 'keep' } = {},
) {
  if (
    hasMusic ||
    hasSubtitles ||
    clipAudio === 'mute' ||
    !clipInfo.length ||
    clipInfo.some(item => item.voices?.length)
  )
    return false;
  if (
    normalizeTransition(
      transition,
      clipInfo.map(item => item.duration),
    ).type !== 'cut'
  )
    return false;
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

const DUCK_LEAD_SECONDS = 0.1;
const DUCK_TAIL_SECONDS = 0.15;

function duckUnderVoices(voices = []) {
  const windows = voices
    .map(
      ({ offset, duration }) =>
        `between(t,${Math.max(0, offset - DUCK_LEAD_SECONDS).toFixed(3)},${(offset + duration + DUCK_TAIL_SECONDS).toFixed(3)})`,
    )
    .join('+');
  return `volume=volume='if(${windows},0,1)':eval=frame`;
}

export function buildEncodeArgs({
  clipInfo,
  inputPaths,
  silentInput,
  music = null,
  transition = null,
  subtitles = null,
  clipAudio = 'keep',
}) {
  const { width, height } = outputFrameSize(clipInfo);
  const usesClipAudio = item => item.hasAudio && clipAudio !== 'mute';
  const durations = clipInfo.map(item => item.duration);
  const blend = normalizeTransition(transition, durations);
  const args = [];
  inputPaths.forEach(path => args.push('-i', path));
  let nextInput = inputPaths.length;
  const silentIndexes = new Map();
  clipInfo.forEach((item, index) => {
    if (usesClipAudio(item)) return;
    silentIndexes.set(index, nextInput++);
    args.push('-stream_loop', '-1', '-i', silentInput);
  });
  const voiceInputs = new Map();
  clipInfo.forEach((item, index) => {
    if (!item.voices?.length) return;
    voiceInputs.set(
      index,
      item.voices.map(voice => {
        args.push('-i', voice.path);
        return { input: nextInput++, offset: voice.offset, duration: Number(voice.duration) || 0 };
      }),
    );
  });
  const musicIndex = music ? nextInput++ : -1;
  if (music) args.push('-stream_loop', '-1', '-i', music.path);

  const filters = [],
    concatInputs = [];
  clipInfo.forEach((item, index) => {
    const duration = item.duration.toFixed(3);
    filters.push(
      `[${index}:v:0]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=24,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS${blend.type === 'cut' ? '' : ',settb=AVTB'}[v${index}]`,
    );
    const audioSource = usesClipAudio(item) ? `${index}:a:0` : `${silentIndexes.get(index)}:a:0`;
    const bedLevel =
      clipAudio === 'duck' ? duckUnderVoices(voiceInputs.get(index)) : `volume=${CLIP_AUDIO_UNDER_VOICE}`;
    filters.push(
      `[${audioSource}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad=pad_dur=${duration},atrim=duration=${duration}${voiceInputs.has(index) ? `,${bedLevel}[bed${index}]` : `[a${index}]`}`,
    );
    const voices = voiceInputs.get(index) || [];
    voices.forEach(({ input, offset }, order) => {
      const delay = Math.round(offset * 1000);
      filters.push(
        `[${input}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,adelay=${delay}|${delay}[voice${index}_${order}]`,
      );
    });
    if (voices.length) {
      const mixInputs = voices.map((_, order) => `[voice${index}_${order}]`).join('');
      // amix divides every input by the input count; scale back so voices keep their level.
      filters.push(
        `[bed${index}]${mixInputs}amix=inputs=${voices.length + 1}:duration=first:dropout_transition=0,volume=${voices.length + 1}[a${index}]`,
      );
    }
    concatInputs.push(`[v${index}][a${index}]`);
  });
  if (blend.type === 'cut' || clipInfo.length < 2)
    filters.push(`${concatInputs.join('')}concat=n=${clipInfo.length}:v=1:a=1[outv][clipa]`);
  else {
    let video = '[v0]',
      audio = '[a0]',
      offset = 0;
    for (let index = 1; index < clipInfo.length; index++) {
      offset += durations[index - 1] - blend.duration;
      const last = index === clipInfo.length - 1,
        nextVideo = last ? '[outv]' : `[xv${index}]`,
        nextAudio = last ? '[clipa]' : `[xa${index}]`;
      filters.push(
        `${video}[v${index}]xfade=transition=${blend.type}:duration=${blend.duration}:offset=${offset.toFixed(3)}${nextVideo}`,
        `${audio}[a${index}]acrossfade=d=${blend.duration}:c1=tri:c2=tri${nextAudio}`,
      );
      video = nextVideo;
      audio = nextAudio;
    }
  }

  let audioOut = '[clipa]';
  if (music) {
    const total = timelineLength(durations, transition);
    const volume = Math.max(0, Math.min(1, Number(music.volume ?? 0.35)));
    const fadeStart = Math.max(0, total - MUSIC_FADE_SECONDS);
    filters.push(
      `[${musicIndex}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,atrim=duration=${total.toFixed(3)},volume=${volume.toFixed(2)},afade=t=out:st=${fadeStart.toFixed(3)}:d=${MUSIC_FADE_SECONDS}[music]`,
    );
    // amix halves each input; doubling restores the clip audio to its original level.
    filters.push('[clipa][music]amix=inputs=2:duration=first:dropout_transition=0,volume=2[mixa]');
    audioOut = '[mixa]';
  }

  let videoOut = '[outv]';
  if (subtitles) {
    filters.push(`[outv]subtitles=filename=${subtitles.path}:fontsdir=${subtitles.fontsDir}[subv]`);
    videoOut = '[subv]';
  }

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    videoOut,
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
