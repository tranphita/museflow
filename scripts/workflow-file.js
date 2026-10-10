import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { workflowFromScript } from '../src/core/film-graph.js';

export const SERIES_BIBLE = '_series.txt';
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export function characterNameFromFile(file) {
  return basename(file, extname(file))
    .replace(/(?:[\s_-]+\d+|\s*\(\d+\))$/, '')
    .trim();
}

export function readCharacterImages(folder) {
  const dir = join(folder, 'characters');
  if (!existsSync(dir)) return {};
  const images = {};
  for (const file of readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const type = IMAGE_TYPES[extname(file).toLowerCase()];
    if (!type) continue;
    const name = characterNameFromFile(file);
    (images[name] ||= []).push(`data:${type};base64,${readFileSync(join(dir, file)).toString('base64')}`);
  }
  return images;
}

export function readEpisodeScript(path) {
  const bible = join(dirname(path), SERIES_BIBLE);
  const episode = readFileSync(path, 'utf8');
  return existsSync(bible) && basename(path) !== SERIES_BIBLE
    ? `${readFileSync(bible, 'utf8').trim()}\n\n${episode}`
    : episode;
}

export function buildWorkflowFile(path) {
  const { version } = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const characterImages = readCharacterImages(dirname(path));
  const workflow = workflowFromScript(readEpisodeScript(path), { characterImages });
  return {
    file: {
      format: 'museta-workflow',
      version: 1,
      appVersion: version,
      exportedAt: new Date().toISOString(),
      workflow,
    },
    summary: summarize(workflow),
  };
}

function summarize(workflow) {
  const cast = workflow.nodes.filter(node => node.data.characterName);
  const saved = [
    ...new Set(cast.filter(node => node.type === 'imageInput').map(node => node.data.characterName)),
  ];
  const generated = cast.filter(node => node.type === 'generateImage').map(node => node.data.characterName);
  const scenes = workflow.nodes.filter(node => node.type === 'generateVideo').length;
  return [
    `${scenes} video clip(s)`,
    saved.length && `saved characters: ${saved.join(', ')}`,
    generated.length && `new character references: ${generated.join(', ')}`,
  ]
    .filter(Boolean)
    .join(' · ');
}
