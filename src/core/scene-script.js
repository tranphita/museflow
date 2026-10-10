const SCENE_HEADING = /^\s*CẢNH\s+(\d+)\s*\(([^)]*)\)\s*:\s*(.*?)\s*$/gim;
const FIELD = {
  image: 'Prompt\\s+ảnh',
  video: 'Prompt\\s+video',
  audio: 'Audio',
  characters: 'Nhân\\s+vật',
  voice: 'Lời\\s+thoại',
};
const otherFields = key => Object.entries(FIELD).flatMap(([name, label]) => (name === key ? [] : [label]));

export function scriptField(section, label, nextLabels) {
  const startPattern = new RegExp(`^\\s*${label}\\s*:\\s*`, 'im'),
    match = startPattern.exec(section);
  if (!match) return '';
  const start = match.index + match[0].length,
    tail = section.slice(start),
    stop = nextLabels.length ? new RegExp(`^\\s*(?:${nextLabels.join('|')})\\s*:`, 'im').exec(tail) : null;
  return tail.slice(0, stop ? stop.index : tail.length).trim();
}

function scriptPreamble(text) {
  const firstScene = text.search(/^\s*CẢNH\s+\d+/im);
  return firstScene >= 0 ? text.slice(0, firstScene) : text;
}

export function parseCharacters(text) {
  const preamble = scriptPreamble(text);
  const heading = /^\s*(?:NHÂN\s+VẬT|CHARACTERS?)\s*:?\s*$/im.exec(preamble);
  if (!heading) return [];
  const characters = [];
  for (const line of preamble.slice(heading.index + heading[0].length).split(/\r?\n/)) {
    if (!line.trim()) {
      if (characters.length) break;
      continue;
    }
    const entry = /^\s*[-*•]?\s*([^:\n]{1,40}?)\s*[:—–]\s*(.+?)\s*$/.exec(line);
    if (!entry) break;
    characters.push({ name: entry[1].trim(), description: entry[2].trim() });
  }
  return characters;
}

export function parseVoices(text) {
  const voices = { default: '', byName: {} };
  for (const [, name, id] of scriptPreamble(text).matchAll(
    /^\s*(?:GIỌNG\s+ĐỌC|VOICE)(?:\s+([^:\n]+?))?\s*:\s*(\S+)\s*$/gim,
  )) {
    if (name) voices.byName[name.trim().normalize('NFC').toLowerCase()] = id;
    else voices.default = id;
  }
  return voices;
}

export function parseVoiceId(text) {
  return parseVoices(text).default;
}

export function voiceFor(voices, speaker) {
  return (speaker && voices.byName[speaker.normalize('NFC').toLowerCase()]) || voices.default;
}

const TRANSLATION_SPLIT = /\s+\|\s+/;
export const HIGHLIGHT = /\*(\S(?:[^*\n]*\S)?)\*/g;

export const stripHighlights = text => text.replace(HIGHLIGHT, '$1');
export const countHighlights = text => [...text.matchAll(HIGHLIGHT)].length;

function bilingual(raw) {
  const split = TRANSLATION_SPLIT.exec(raw);
  const en = (split ? raw.slice(0, split.index) : raw).trim(),
    vi = split ? raw.slice(split.index + split[0].length).trim() : '';
  const marked = Boolean(split) || new RegExp(HIGHLIGHT.source).test(en);
  return { text: stripHighlights(en), ...(marked ? { subtitle: { en, vi } } : {}) };
}

const joinText = (first, second) => [first, second].filter(Boolean).join(' ');

function mergeLines(previous, line) {
  const subtitle =
    previous.subtitle || line.subtitle
      ? {
          en: joinText(previous.subtitle?.en ?? previous.text, line.subtitle?.en ?? line.text),
          vi: joinText(previous.subtitle?.vi, line.subtitle?.vi),
        }
      : null;
  previous.text = joinText(previous.text, line.text);
  if (subtitle) previous.subtitle = subtitle;
}

export function parseVoiceLines(voiceText, speakerNames = []) {
  const known = new Set(speakerNames.map(name => name.normalize('NFC').toLowerCase()));
  const unquote = line => line.replace(/^["“”']+|["“”']+$/g, '').trim();
  const lines = voiceText
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*[-*•]\s+|^\s*[-•]/, '').trim())
    .filter(Boolean)
    .map(line => {
      const spoken = /^([^:\n]{1,40}?)\s*:\s*(.+)$/.exec(line);
      return spoken && known.has(spoken[1].trim().normalize('NFC').toLowerCase())
        ? { speaker: spoken[1].trim(), ...bilingual(unquote(spoken[2])) }
        : { speaker: '', ...bilingual(unquote(line)) };
    });
  const merged = [];
  for (const line of lines) {
    const previous = merged.at(-1);
    if (previous && !line.speaker && !previous.speaker) mergeLines(previous, line);
    else merged.push(line);
  }
  return merged.filter(line => line.text);
}

export function parseClipAudio(text) {
  const value =
    /^\s*(?:ÂM\s+THANH\s+CLIP|CLIP\s+AUDIO)\s*:\s*(.+?)\s*$/im.exec(scriptPreamble(text))?.[1] || '';
  return /^(?:tắt|câm|off|mute)/i.test(value) ? 'mute' : 'keep';
}

export const DEFAULT_SERIES_MUSIC_VOLUME = 0.25;

export function parseMusic(text) {
  const preamble = scriptPreamble(text);
  const file = /^\s*(?:NHẠC\s+NỀN|BACKGROUND\s+MUSIC)\s*:\s*(.+?)\s*$/im.exec(preamble)?.[1];
  if (!file) return null;
  const raw = /^\s*(?:ÂM\s+LƯỢNG\s+NHẠC|MUSIC\s+VOLUME)\s*:\s*([\d.,]+)\s*(%?)\s*$/im.exec(preamble);
  const number = raw ? Number(raw[1].replace(',', '.')) : NaN;
  const volume = Number.isFinite(number)
    ? Math.max(0, Math.min(1, raw[2] ? number / 100 : number))
    : DEFAULT_SERIES_MUSIC_VOLUME;
  return { file, volume };
}

export function parseSubtitleMode(text) {
  const value = /^\s*(?:PHỤ\s+ĐỀ|SUBTITLES?)\s*:\s*(.+?)\s*$/im.exec(scriptPreamble(text))?.[1] || '';
  return /song\s*ngữ|bilingual/i.test(value) ? 'bilingual' : 'off';
}

export function parseAvoid(text) {
  return /^\s*(?:TRÁNH|AVOID)\s*:\s*(.+?)\s*$/im.exec(scriptPreamble(text))?.[1] || '';
}

export function parseFilmStyle(text) {
  return /^\s*(?:PHONG\s+CÁCH|STYLE)\s*:\s*(.+?)\s*$/im.exec(scriptPreamble(text))?.[1] || '';
}

function namesInField(field) {
  return field
    .split(/[,;\n]|\s+và\s+/i)
    .map(name => name.trim())
    .filter(Boolean);
}

export function charactersForScene(scene, characters) {
  if (!characters.length) return [];
  const byName = name => characters.find(character => character.name.toLowerCase() === name.toLowerCase());
  if (scene.characterNames.length) return scene.characterNames.map(byName).filter(Boolean);
  const text = `${scene.imagePrompt} ${scene.videoPrompt}`.toLowerCase();
  const mentioned = characters.filter(character => text.includes(character.name.toLowerCase()));
  return mentioned.length ? mentioned : characters;
}

export function parseSceneScript(text) {
  const matches = [...text.matchAll(SCENE_HEADING)];
  return matches
    .map((match, index) => {
      const body = text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length),
        imagePrompt = scriptField(body, FIELD.image, otherFields('image')),
        videoPrompt = scriptField(body, FIELD.video, otherFields('video')),
        audio = scriptField(body, FIELD.audio, otherFields('audio')),
        characterNames = namesInField(scriptField(body, FIELD.characters, otherFields('characters'))),
        voiceText = scriptField(body, FIELD.voice, otherFields('voice')),
        range = match[2].match(/(\d+):(\d{2})\s*[–—-]\s*(\d+):(\d{2})/);
      const seconds = range
        ? Number(range[3]) * 60 + Number(range[4]) - (Number(range[1]) * 60 + Number(range[2]))
        : 0;
      const ratio = (imagePrompt + ' ' + videoPrompt).match(/\b(9:16|16:9|1:1|4:3|3:4)\b/);
      return {
        number: Number(match[1]),
        title: match[3].trim(),
        imagePrompt,
        videoPrompt: [videoPrompt, audio ? `Audio direction: ${audio}` : ''].filter(Boolean).join('\n\n'),
        characterNames,
        voiceText,
        seconds: seconds > 0 ? seconds : 6,
        size: ratio?.[1] || '9:16',
      };
    })
    .filter(scene => scene.imagePrompt || scene.videoPrompt);
}

export function characterSheetPrompt(character, filmStyle = '') {
  return `Character reference for "${character.name}": ${character.description}. Full body and close-up of the face side by side, front view, neutral expression, plain light-grey background, even soft lighting, no text or labels.${filmStyle ? ` Style: ${filmStyle}.` : ''}`;
}

export function castNote(characters) {
  if (!characters.length) return '';
  return `Characters in this shot (keep each one identical to their reference image): ${characters
    .map(character => `${character.name} — ${character.description}`)
    .join('; ')}.`;
}

export function nextShotHint(scene) {
  if (!scene) return '';
  const firstSentence = (scene.videoPrompt || scene.imagePrompt).split(/(?<=[.!?])\s|\n/)[0].trim();
  return [scene.title, firstSentence].filter(Boolean).join(': ').slice(0, 220);
}
