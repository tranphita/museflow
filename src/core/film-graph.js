import { uid, makeNode, isGenerator } from './node-defs.js';
import {
  parseSceneScript,
  parseCharacters,
  parseFilmStyle,
  charactersForScene,
  characterSheetPrompt,
  castNote,
  nextShotHint,
} from './scene-script.js';

export const DEFAULT_FILM_TRANSITION = Object.freeze({ type: 'fade', duration: 0.5 });

const edge = (source, sourcePort, target, targetPort) => ({
  id: uid('edge'),
  source,
  sourcePort,
  target,
  targetPort,
});

function closestVideoDuration(seconds) {
  return [5, 6, 8, 10].reduce(
    (best, value) => (Math.abs(value - seconds) < Math.abs(best - seconds) ? value : best),
    5,
  );
}

export function buildSceneGraph(script, { baseY = 40 } = {}) {
  const scenes = parseSceneScript(script),
    characters = parseCharacters(script),
    filmStyle = parseFilmStyle(script);
  if (!scenes.length) return null;
  const nodes = [],
    edges = [],
    videos = [];
  const cast = characters.map((character, index) => {
    const x = 80 + index * 650,
      label = `Character: ${character.name}`;
    const prompt = makeNode('prompt', x, baseY);
    prompt.data = { text: characterSheetPrompt(character, filmStyle), sceneLabel: label };
    const image = makeNode('generateImage', x + 330, baseY);
    image.data = {
      model: 'muse-image',
      size: '3:4',
      status: 'idle',
      sceneLabel: label,
      characterName: character.name,
    };
    nodes.push(prompt, image);
    edges.push(edge(prompt.id, 'text', image.id, 'prompt'));
    return { ...character, node: image };
  });
  const scenesY = cast.length ? baseY + 620 : baseY;
  const styleNote = filmStyle ? `Visual style for the whole film: ${filmStyle}.` : '';
  scenes.forEach((scene, index) => {
    const x = 80 + (index % 4) * 650,
      y = scenesY + Math.floor(index / 4) * 1100,
      label = `Scene ${scene.number}${scene.title ? `: ${scene.title}` : ''}`,
      sceneCast = charactersForScene(scene, cast),
      promptText = text => [text, castNote(sceneCast), styleNote].filter(Boolean).join('\n\n');
    const connectCast = target => {
      for (const character of sceneCast) edges.push(edge(character.node.id, 'image', target.id, 'reference'));
    };
    let imageNode = null;
    if (scene.imagePrompt) {
      const prompt = makeNode('prompt', x, y);
      prompt.data = { text: promptText(scene.imagePrompt), sceneLabel: label };
      imageNode = makeNode('generateImage', x + 330, y);
      imageNode.data = { model: 'muse-image', size: scene.size, status: 'idle', sceneLabel: label };
      nodes.push(prompt, imageNode);
      edges.push(edge(prompt.id, 'text', imageNode.id, 'prompt'));
      connectCast(imageNode);
    }
    if (scene.videoPrompt) {
      const prompt = makeNode('prompt', x, y + 540);
      prompt.data = { text: promptText(scene.videoPrompt), sceneLabel: label };
      const videoNode = makeNode('generateVideo', x + 330, y + 540);
      videoNode.data = {
        model: 'muse-video',
        size: scene.size,
        duration: closestVideoDuration(scene.seconds),
        continuity: videos.length > 0,
        nextShot: nextShotHint(scenes[index + 1]),
        status: 'idle',
        sceneLabel: label,
      };
      nodes.push(prompt, videoNode);
      edges.push(edge(prompt.id, 'text', videoNode.id, 'prompt'));
      if (imageNode) edges.push(edge(imageNode.id, 'image', videoNode.id, 'reference'));
      connectCast(videoNode);
      videos.push({ node: videoNode, seconds: scene.seconds });
    }
  });
  return { nodes, edges, scenes, cast, videos };
}

export function workflowFromScript(script) {
  const graph = buildSceneGraph(script);
  if (!graph) throw new Error('No scenes found. Use headings like “CẢNH 1 (0:00–0:07): Title”.');
  const references = makeNode('references', -280, 40);
  references.data = {};
  const timeline = {
    id: uid('timeline'),
    type: 'timeline',
    x: 0,
    y: 0,
    data: {
      dockOnly: true,
      clipOrder: graph.videos.map(video => video.node.id),
      durations: Object.fromEntries(graph.videos.map(video => [video.node.id, video.seconds])),
      ...(graph.videos.length > 1 ? { transition: { ...DEFAULT_FILM_TRANSITION } } : {}),
    },
  };
  const fanOut = graph.nodes
    .filter(isGenerator)
    .map(node => edge(references.id, 'image', node.id, 'reference'));
  const steps = [
    graph.cast.length &&
      `1. Run each "Character" image node first. Pick the best version in its Versions strip (or tick 🔒 Keep) so Run workflow keeps it.`,
    `${graph.cast.length ? 2 : 1}. Run workflow to generate every scene in timeline order.`,
    `${graph.cast.length ? 3 : 2}. Check the Timeline, add ♪ Music if you like, then export MP4.`,
  ].filter(Boolean);
  return {
    nodes: [references, ...graph.nodes, timeline],
    edges: [...graph.edges, ...fanOut],
    groups: [],
    notes: [{ id: uid('note'), x: -280, y: 300, width: 300, height: 190, text: steps.join('\n') }],
    settings: { autoRetry: 0, continueOnError: true },
  };
}
