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

export function readCharacterImages(folder) {
  const dir = join(folder, 'characters');
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir)
      .filter(file => IMAGE_TYPES[extname(file).toLowerCase()])
      .map(file => [
        basename(file, extname(file)),
        `data:${IMAGE_TYPES[extname(file).toLowerCase()]};base64,${readFileSync(join(dir, file)).toString('base64')}`,
      ]),
  );
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
  const saved = cast.filter(node => node.type === 'imageInput').map(node => node.data.characterName);
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
