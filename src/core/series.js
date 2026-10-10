import { parseSceneScript, parseVoiceLines, parseCharacters } from './scene-script.js';

export const SERIES_BIBLE = '_series.txt';
export const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

const extensionOf = name => /\.[^.]+$/.exec(name)?.[0].toLowerCase() || '';
const stem = name => name.replace(/\.[^.]+$/, '');

export function characterNameFromFile(file) {
  return stem(file)
    .normalize('NFC')
    .replace(/(?:[\s_-]+\d+|\s*\(\d+\))$/, '')
    .trim();
}

export function isEpisodeFile(name) {
  return /^ep\d+.*\.txt$/i.test(name);
}

export function parseSeriesName(text) {
  return /^\s*(?:TÊN\s+BỘ|SERIES)\s*:\s*(.+?)\s*$/im.exec(text)?.[1] || '';
}

export function parseEpisodeTitle(text) {
  return /^\s*(?:TIÊU\s+ĐỀ|TITLE)\s*:\s*(.+?)\s*$/im.exec(text)?.[1] || '';
}

export function humanizeSlug(name) {
  const words = stem(name)
    .replace(/^ep\d+[-_\s]*/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return words ? words[0].toUpperCase() + words.slice(1) : stem(name);
}

export function episodeNumber(name) {
  return Number(/^ep(\d+)/i.exec(name)?.[1]) || 0;
}

export function describeEpisode(fileName, text, bible = '') {
  const scenes = parseSceneScript(text);
  const speakers = parseCharacters(bible).map(character => character.name);
  return {
    number: episodeNumber(fileName),
    title: parseEpisodeTitle(text) || humanizeSlug(fileName),
    scenes: scenes.length,
    seconds: scenes.reduce((sum, scene) => sum + scene.seconds, 0),
    lines: scenes.reduce((sum, scene) => sum + parseVoiceLines(scene.voiceText, speakers).length, 0),
  };
}

export function episodeScript(bible, episode) {
  return bible.trim() ? `${bible.trim()}\n\n${episode}` : episode;
}

export function groupCharacterFiles(files) {
  const images = {};
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    if (!IMAGE_TYPES[extensionOf(file.name)]) continue;
    (images[characterNameFromFile(file.name)] ||= []).push(file);
  }
  return images;
}

export function audioTypeOf(name) {
  return AUDIO_TYPES[extensionOf(name)] || '';
}

export function imageTypeOf(name) {
  return IMAGE_TYPES[extensionOf(name)] || '';
}
