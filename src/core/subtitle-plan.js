import { normalizeTransition, timelineLength } from './ffmpeg-plan.js';
import { HIGHLIGHT } from './scene-script.js';
import { wordTimings } from './learning-fx.js';

export const SUBTITLE_FONT = Object.freeze({
  file: 'BeVietnamPro-ExtraBold.ttf',
  name: 'Be Vietnam Pro ExtraBold',
});
const LINGER_SECONDS = 0.25;
// A word joiner after a literal backslash stops libass reading it as an override like \N or \h.
const WORD_JOINER = String.fromCharCode(0x2060);
const COLORS = {
  en: '&HFFFFFF&',
  vi: '&HE6F5FF&',
  highlight: '&H4DD8FF&',
  spoken: '&H9DF5FF&',
  spokenHighlight: '&H0095FF&',
  countdown: '&H4DD8FF&',
};
const round2 = value => Math.round(value * 100) / 100;

export function voiceSubtitle(data = {}) {
  return {
    en: String(data.subtitle?.en ?? data.text ?? '').trim(),
    vi: String(data.subtitle?.vi ?? '').trim(),
  };
}

export function buildSubtitleEvents({ clips, transition = null, karaoke = false }) {
  const durations = clips.map(clip => clip.duration);
  const blend = normalizeTransition(transition, durations).duration;
  const total = timelineLength(durations, transition);
  const lines = [];
  let clipStart = 0;
  clips.forEach((clip, index) => {
    if (index) clipStart += durations[index - 1] - blend;
    for (const voice of clip.voices || []) {
      if (!voice.en?.trim()) continue;
      const start = clipStart + voice.offset;
      const linger = Math.max(LINGER_SECONDS, Number(voice.hold) || 0);
      lines.push({
        start,
        end: start + voice.duration + linger,
        en: voice.en,
        vi: voice.vi || '',
        ...(karaoke ? { words: wordTimings(voice.en, voice.duration, voice.words) } : {}),
      });
    }
  });
  return lines
    .map((line, index) => ({
      ...line,
      end: Math.min(line.end, lines[index + 1]?.start ?? Infinity, total),
    }))
    .filter(line => line.end > line.start)
    .map(line => ({ ...line, start: round2(line.start), end: round2(line.end) }));
}

const escapeAss = text =>
  text
    .replace(/\\/g, `\\${WORD_JOINER}`)
    .replace(/[{}]/g, brace => `\\${brace}`)
    .replace(/\s*\r?\n\s*/g, ' ');
const colour = (value, karaoke) => (karaoke ? `\\c${value}\\2c${value}` : `\\c${value}`);
const paint = (text, base, karaoke = false) =>
  escapeAss(text).replace(HIGHLIGHT, `{${colour(COLORS.highlight, karaoke)}}$1{${colour(base, karaoke)}}`);

function assTime(seconds) {
  const centis = Math.round(seconds * 100),
    hours = Math.floor(centis / 360000),
    minutes = Math.floor((centis % 360000) / 6000),
    secs = Math.floor((centis % 6000) / 100);
  const pad = value => String(value).padStart(2, '0');
  return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(centis % 100)}`;
}

const centis = seconds => Math.max(0, Math.round(seconds * 100));

export function karaokeText(words) {
  let cursor = 0;
  return words
    .map((word, index) => {
      const next = words[index + 1],
        gap = centis(word.start - cursor),
        length = Math.max(1, centis((next ? next.start : word.end) - word.start)),
        [unspoken, spoken] = word.highlight
          ? [COLORS.highlight, COLORS.spokenHighlight]
          : [COLORS.en, COLORS.spoken];
      cursor = word.start + length / 100;
      return `${gap ? `{\\k${gap}}` : ''}{\\kf${length}\\2c${unspoken}\\1c${spoken}}${escapeAss(word.text)}${next ? ' ' : ''}`;
    })
    .join('');
}

function circlePath(radius) {
  const r = radius,
    d = 2 * radius,
    near = r - Math.round(radius * 0.5523),
    far = r + Math.round(radius * 0.5523);
  return `m ${r} 0 b ${far} 0 ${d} ${near} ${d} ${r} b ${d} ${far} ${far} ${d} ${r} ${d} b ${near} ${d} 0 ${far} 0 ${r} b 0 ${near} ${near} 0 ${r} 0`;
}

export function countdownDialogue({ countdowns, width, height }) {
  const x = Math.round(width / 2),
    y = Math.round(height * 0.44),
    radius = Math.round(height * 0.05),
    barWidth = Math.round(width * 0.36),
    barHeight = Math.max(4, Math.round(height * 0.008)),
    barX = x - Math.round(barWidth / 2),
    barY = y + radius + Math.round(height * 0.02),
    numberSize = Math.round(radius * 1.3);
  return countdowns.flatMap(({ start, seconds, length }) => {
    const span = `${assTime(start)},${assTime(start + length)}`,
      step = length / seconds;
    return [
      `Dialogue: 1,${span},Countdown,,0,0,0,,{\\an5\\pos(${x},${y})\\bord0\\shad0\\1c&H000000&\\1a&H60&\\p1}${circlePath(radius)}`,
      `Dialogue: 1,${span},Countdown,,0,0,0,,{\\an7\\pos(${barX},${barY})\\bord0\\shad0\\1c${COLORS.countdown}\\t(0,${Math.round(length * 1000)},\\fscx0)\\p1}m 0 0 l ${barWidth} 0 ${barWidth} ${barHeight} 0 ${barHeight}`,
      ...Array.from(
        { length: seconds },
        (_, tick) =>
          `Dialogue: 2,${assTime(start + tick * step)},${assTime(start + (tick + 1) * step)},Countdown,,0,0,0,,{\\an5\\pos(${x},${y})\\fs${numberSize}\\1c${COLORS.countdown}\\fscx140\\fscy140\\t(0,180,\\fscx100\\fscy100)}${seconds - tick}`,
      ),
    ];
  });
}

export function buildAss({ events, width, height, countdowns = [] }) {
  const enSize = Math.round(height * 0.058),
    viSize = Math.round(height * 0.034),
    outline = Math.max(2, Math.round(enSize * 0.1)),
    marginX = Math.round(width * 0.07),
    marginV = Math.round(height * 0.22);
  const dialogue = events.map(event => {
    const karaoke = Boolean(event.words?.length);
    const vi = event.vi?.trim()
      ? `\\N{${karaoke ? '\\k0' : ''}\\fs${viSize}${colour(COLORS.vi, karaoke)}}${paint(event.vi.trim(), COLORS.vi, karaoke)}`
      : '';
    const en = karaoke ? karaokeText(event.words) : paint(event.en.trim(), COLORS.en);
    return `Dialogue: 0,${assTime(event.start)},${assTime(event.end)},Default,,0,0,0,,${en}${vi}`;
  });
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${SUBTITLE_FONT.name},${enSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${outline},2,2,${marginX},${marginX},${marginV},1`,
    `Style: Countdown,${SUBTITLE_FONT.name},${enSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${outline},0,5,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...dialogue,
    ...countdownDialogue({ countdowns, width, height }),
    '',
  ].join('\n');
}
