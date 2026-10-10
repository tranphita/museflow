const SCENE_HEADING = /^\s*CẢNH\s+(\d+)\s*\(([^)]*)\)\s*:\s*(.*?)\s*$/gim;
const FIELD = {
  image: 'Prompt\\s+ảnh',
  video: 'Prompt\\s+video',
  audio: 'Audio',
  characters: 'Nhân\\s+vật',
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
        seconds: seconds > 0 ? seconds : 6,
        size: ratio?.[1] || '9:16',
      };
    })
    .filter(scene => scene.imagePrompt || scene.videoPrompt);
}

export function characterSheetPrompt(character) {
  return `Character reference sheet for "${character.name}": ${character.description}. Full body and close-up face side by side, front view, neutral expression, plain light-grey background, even soft lighting, no text or labels.`;
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
