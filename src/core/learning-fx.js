import { normalizeTransition } from './ffmpeg-plan.js';
import { HIGHLIGHT } from './scene-script.js';

export const LEARNING_FX = Object.freeze(['karaoke', 'countdown', 'pop']);
const MIN_COUNTDOWN_SECONDS = 1;
const POP_LEAD_SECONDS = 0.15;
const DING_SECONDS = 0.9;
const POP_SECONDS = 0.15;
const round2 = value => Math.round(value * 100) / 100;

export function hasFx(fx, name) {
  return Array.isArray(fx) && fx.includes(name);
}

export function wordsFromAlignment(alignment) {
  const characters = alignment?.characters || [],
    starts = alignment?.character_start_times_seconds || [],
    ends = alignment?.character_end_times_seconds || [];
  const words = [];
  let current = null;
  characters.forEach((character, index) => {
    if (/\s/.test(character)) {
      current = null;
      return;
    }
    if (!current) {
      current = { text: '', start: Number(starts[index]) || 0, end: 0 };
      words.push(current);
    }
    current.text += character;
    current.end = Number(ends[index]) || current.start;
  });
  return words.map(word => ({ ...word, start: round2(word.start), end: round2(word.end) }));
}

export function markedWords(text) {
  let plain = '',
    last = 0;
  const marked = [];
  const append = (chunk, highlight) => {
    plain += chunk;
    for (let index = 0; index < chunk.length; index++) marked.push(highlight);
  };
  for (const match of String(text || '').matchAll(HIGHLIGHT)) {
    append(text.slice(last, match.index), false);
    append(match[1], true);
    last = match.index + match[0].length;
  }
  append(String(text || '').slice(last), false);
  return [...plain.matchAll(/\S+/g)].map(match => ({
    text: match[0],
    highlight: marked.slice(match.index, match.index + match[0].length).some(Boolean),
  }));
}

export function wordTimings(text, duration, spokenWords = []) {
  const words = markedWords(text);
  if (!words.length) return [];
  if (spokenWords.length === words.length)
    return words.map((word, index) => ({
      ...word,
      start: spokenWords[index].start,
      end: spokenWords[index].end,
    }));
  const weights = words.map(word => word.text.length + 1),
    total = weights.reduce((sum, weight) => sum + weight, 0),
    length = Math.max(0, Number(duration) || 0);
  let cursor = 0;
  return words.map((word, index) => {
    const start = cursor;
    cursor += (weights[index] / total) * length;
    return { ...word, start: round2(start), end: round2(cursor) };
  });
}

export function clipStarts(durations, transition) {
  const blend = normalizeTransition(transition, durations).duration;
  const starts = [];
  let start = 0;
  durations.forEach((duration, index) => {
    if (index) start += durations[index - 1] - blend;
    starts.push(start);
  });
  return starts;
}

export function buildCountdowns({ clips, transition = null }) {
  const starts = clipStarts(
    clips.map(clip => clip.duration),
    transition,
  );
  return clips.flatMap((clip, index) =>
    (clip.voices || [])
      .filter(voice => Number(voice.hold) >= MIN_COUNTDOWN_SECONDS)
      .map(voice => ({
        start: round2(starts[index] + voice.offset + voice.duration),
        seconds: Math.round(Number(voice.hold)),
        length: round2(Number(voice.hold)),
      })),
  );
}

export function buildAudioCues({ clips, transition = null, fx = [] }) {
  const starts = clipStarts(
    clips.map(clip => clip.duration),
    transition,
  );
  const cues = [];
  clips.forEach((clip, index) => {
    for (const voice of clip.voices || []) {
      const lineStart = starts[index] + voice.offset;
      if (hasFx(fx, 'pop') && new RegExp(HIGHLIGHT.source).test(voice.en || ''))
        cues.push({ kind: 'pop', at: round2(Math.max(0, lineStart - POP_LEAD_SECONDS)) });
      if (hasFx(fx, 'countdown') && Number(voice.hold) >= MIN_COUNTDOWN_SECONDS)
        cues.push({ kind: 'ding', at: round2(lineStart + voice.duration) });
    }
  });
  return cues.sort((a, b) => a.at - b.at);
}

const CUE_SOUND = {
  ding: (shift, at) =>
    `between(t,${at},${round2(at + DING_SECONDS)})*(0.45*sin(2*PI*1568*${shift})*exp(-4*${shift})+0.2*sin(2*PI*2349*${shift})*exp(-5*${shift}))`,
  pop: (shift, at) =>
    `between(t,${at},${round2(at + POP_SECONDS)})*0.4*sin(2*PI*(300+2200*${shift})*${shift})*exp(-28*${shift})`,
};

export function cueExpression(cues) {
  const terms = cues.map(({ kind, at }) => CUE_SOUND[kind]?.(`(t-${at})`, at)).filter(Boolean);
  return terms.join('+');
}
