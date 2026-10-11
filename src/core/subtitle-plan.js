import { normalizeTransition, timelineLength } from './ffmpeg-plan.js';
import { HIGHLIGHT } from './scene-script.js';

export const SUBTITLE_FONT = Object.freeze({
  file: 'BeVietnamPro-ExtraBold.ttf',
  name: 'Be Vietnam Pro ExtraBold',
});
const LINGER_SECONDS = 0.25;
// A word joiner after a literal backslash stops libass reading it as an override like \N or \h.
const WORD_JOINER = String.fromCharCode(0x2060);
const COLORS = { en: '&HFFFFFF&', vi: '&HE6F5FF&', highlight: '&H4DD8FF&' };
const round2 = value => Math.round(value * 100) / 100;

export function voiceSubtitle(data = {}) {
  return {
    en: String(data.subtitle?.en ?? data.text ?? '').trim(),
    vi: String(data.subtitle?.vi ?? '').trim(),
  };
}

export function buildSubtitleEvents({ clips, transition = null }) {
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
      lines.push({ start, end: start + voice.duration + LINGER_SECONDS, en: voice.en, vi: voice.vi || '' });
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
const paint = (text, base) => escapeAss(text).replace(HIGHLIGHT, `{\\c${COLORS.highlight}}$1{\\c${base}}`);

function assTime(seconds) {
  const centis = Math.round(seconds * 100),
    hours = Math.floor(centis / 360000),
    minutes = Math.floor((centis % 360000) / 6000),
    secs = Math.floor((centis % 6000) / 100);
  const pad = value => String(value).padStart(2, '0');
  return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(centis % 100)}`;
}

export function buildAss({ events, width, height }) {
  const enSize = Math.round(height * 0.058),
    viSize = Math.round(height * 0.034),
    outline = Math.max(2, Math.round(enSize * 0.1)),
    marginX = Math.round(width * 0.07),
    marginV = Math.round(height * 0.22);
  const dialogue = events.map(event => {
    const vi = event.vi?.trim()
      ? `\\N{\\fs${viSize}\\c${COLORS.vi}}${paint(event.vi.trim(), COLORS.vi)}`
      : '';
    return `Dialogue: 0,${assTime(event.start)},${assTime(event.end)},Default,,0,0,0,,${paint(event.en.trim(), COLORS.en)}${vi}`;
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
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...dialogue,
    '',
  ].join('\n');
}
