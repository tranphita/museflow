import { uid, makeNode, isGenerator, DEFAULT_VOICE_ID, MUSE_VIDEO_SECONDS } from './node-defs.js';
import { parseRules, rulesFor } from './script-check.js';
import {
  parseSceneScript,
  parseCharacters,
  parseFilmStyle,
  parseAvoid,
  parseVoices,
  parseVoiceLines,
  parseSubtitleMode,
  parseClipAudio,
  parseMusic,
  parseMasterShot,
  parseLearningFx,
  DEFAULT_SERIES_MUSIC_VOLUME,
  voiceFor,
  charactersForScene,
  characterSheetPrompt,
  castNote,
  nextShotHint,
} from './scene-script.js';

export const MAX_PHOTOS_PER_CHARACTER = 4;
export const DEFAULT_FILM_TRANSITION = Object.freeze({ type: 'fade', duration: 0.5 });

const edge = (source, sourcePort, target, targetPort) => ({
  id: uid('edge'),
  source,
  sourcePort,
  target,
  targetPort,
});

export function videoDurationFor(seconds) {
  return MUSE_VIDEO_SECONDS.find(value => value >= seconds) ?? MUSE_VIDEO_SECONDS.at(-1);
}

export function buildSceneGraph(script, { baseY = 40, characterImages = {} } = {}) {
  const scenes = parseSceneScript(script),
    characters = parseCharacters(script),
    filmStyle = parseFilmStyle(script),
    rules = parseRules(script),
    voices = parseVoices(script),
    voiceLines = scenes.map(scene =>
      parseVoiceLines(
        scene.voiceText,
        characters.map(character => character.name),
      ),
    ),
    voiceRows = Math.max(0, ...voiceLines.map(lines => Math.ceil(lines.length / 2))),
    rowHeight = voiceRows ? 1040 + voiceRows * 440 : 1100;
  if (!scenes.length) return null;
  const nodes = [],
    edges = [],
    videos = [];
  const savedImages = name => {
    const match = Object.entries(characterImages).find(
      ([key]) => key.normalize('NFC').toLowerCase() === name.normalize('NFC').toLowerCase(),
    );
    return [match?.[1] || []].flat().slice(0, MAX_PHOTOS_PER_CHARACTER);
  };
  const cast = characters.map((character, index) => {
    const x = 80 + index * 650,
      label = `Nhân vật: ${character.name}`,
      photos = savedImages(character.name);
    if (photos.length) {
      const inputs = photos.map((url, photo) => {
        const input = makeNode('imageInput', x + 330, baseY + photo * 380);
        input.data = {
          localDataUrl: url,
          sceneLabel: photos.length > 1 ? `${label} (${photo + 1}/${photos.length})` : label,
          characterName: character.name,
        };
        return input;
      });
      nodes.push(...inputs);
      return { ...character, nodes: inputs };
    }
    const prompt = makeNode('prompt', x, baseY);
    prompt.data = { text: characterSheetPrompt(character, filmStyle), sceneLabel: label };
    const image = makeNode('generateImage', x + 330, baseY);
    image.data = {
      model: 'muse-image',
      size: '3:4',
      status: 'idle',
      sceneLabel: label,
      characterName: character.name,
      continuityRules: rulesFor(rules, [character.name]),
      ...(filmStyle ? { filmStyle } : {}),
    };
    nodes.push(prompt, image);
    edges.push(edge(prompt.id, 'text', image.id, 'prompt'));
    return { ...character, nodes: [image] };
  });
  const tallestCast = Math.max(1, ...cast.map(character => character.nodes.length));
  const scenesY = cast.length ? baseY + 620 + (tallestCast - 1) * 380 : baseY;
  const styleNote = filmStyle ? `Visual style for the whole film: ${filmStyle}.` : '';
  const masterShot = parseMasterShot(script);
  let masterImage = null;
  if (masterShot) {
    const x = 80 + cast.length * 650,
      label = 'Bối cảnh chính';
    const prompt = makeNode('prompt', x, baseY);
    prompt.data = {
      text: [
        `Master wide shot of the set for this episode, no people in frame: ${masterShot}`,
        'Show the whole space clearly with every prop in its starting place, eye-level camera, even soft light.',
        styleNote,
      ]
        .filter(Boolean)
        .join('\n\n'),
      sceneLabel: label,
    };
    masterImage = makeNode('generateImage', x + 330, baseY);
    masterImage.data = {
      model: 'muse-image',
      size: parseSceneScript(script)[0]?.size || '9:16',
      status: 'idle',
      sceneLabel: label,
      setReference: true,
      continuityRules: rules.general,
      ...(filmStyle ? { filmStyle } : {}),
    };
    nodes.push(prompt, masterImage);
    edges.push(edge(prompt.id, 'text', masterImage.id, 'prompt'));
  }
  scenes.forEach((scene, index) => {
    const x = 80 + (index % 4) * 650,
      y = scenesY + Math.floor(index / 4) * rowHeight,
      label = `Cảnh ${scene.number}${scene.title ? `: ${scene.title}` : ''}`,
      sceneCast = charactersForScene(scene, cast),
      sceneRules = rulesFor(
        rules,
        sceneCast.map(character => character.name),
      ),
      promptText = text => [text, castNote(sceneCast), styleNote].filter(Boolean).join('\n\n');
    const connectCast = target => {
      for (const character of sceneCast)
        for (const source of character.nodes) edges.push(edge(source.id, 'image', target.id, 'reference'));
    };
    let imageNode = null;
    if (scene.imagePrompt) {
      const prompt = makeNode('prompt', x, y);
      prompt.data = { text: promptText(scene.imagePrompt), sceneLabel: label };
      imageNode = makeNode('generateImage', x + 330, y);
      imageNode.data = {
        model: 'muse-image',
        size: scene.size,
        status: 'idle',
        sceneLabel: label,
        continuityRules: sceneRules,
        ...(filmStyle ? { filmStyle } : {}),
      };
      nodes.push(prompt, imageNode);
      edges.push(edge(prompt.id, 'text', imageNode.id, 'prompt'));
      connectCast(imageNode);
      if (masterImage) edges.push(edge(masterImage.id, 'image', imageNode.id, 'reference'));
    }
    if (scene.videoPrompt) {
      const prompt = makeNode('prompt', x, y + 540);
      prompt.data = { text: promptText(scene.videoPrompt), sceneLabel: label };
      const videoNode = makeNode('generateVideo', x + 330, y + 540);
      videoNode.data = {
        model: 'muse-video',
        size: scene.size,
        duration: videoDurationFor(scene.seconds),
        continuity: videos.length > 0,
        nextShot: nextShotHint(scenes[index + 1]),
        status: 'idle',
        sceneLabel: label,
        continuityRules: sceneRules,
        ...(filmStyle ? { filmStyle } : {}),
      };
      nodes.push(prompt, videoNode);
      edges.push(edge(prompt.id, 'text', videoNode.id, 'prompt'));
      if (imageNode) edges.push(edge(imageNode.id, 'image', videoNode.id, 'reference'));
      connectCast(videoNode);
      voiceLines[index].forEach((line, order) => {
        const voice = makeNode('voiceover', x + (order % 2) * 330, y + 980 + Math.floor(order / 2) * 440);
        voice.data = {
          text: line.text,
          voiceId: voiceFor(voices, line.speaker) || DEFAULT_VOICE_ID,
          speed: 1,
          status: 'idle',
          sceneLabel: `${label}${line.speaker ? ` · ${line.speaker}` : ''} · ${order + 1}`,
          ...(line.speaker ? { speaker: line.speaker } : {}),
          ...(line.subtitle ? { subtitle: line.subtitle } : {}),
          ...(line.pauseAfter ? { pauseAfter: line.pauseAfter } : {}),
        };
        nodes.push(voice);
        edges.push(edge(voice.id, 'audio', videoNode.id, 'voice'));
      });
      videos.push({ node: videoNode, seconds: scene.seconds });
    }
  });
  const avoid = parseAvoid(script);
  if (avoid) {
    const negative = makeNode('negativePrompt', -280, baseY + 560);
    negative.data = { text: avoid, sceneLabel: 'Tránh trong mọi cảnh quay' };
    nodes.push(negative);
    for (const target of nodes.filter(isGenerator))
      edges.push(edge(negative.id, 'text', target.id, 'negative'));
  }
  return { nodes, edges, scenes, cast, videos };
}

export function workflowFromScript(script, { characterImages = {}, music = null } = {}) {
  const graph = buildSceneGraph(script, { characterImages });
  if (!graph) throw new Error('Không tìm thấy cảnh nào. Dùng tiêu đề dạng “CẢNH 1 (0:00–0:07): Tên cảnh”.');
  const references = makeNode('references', -280, 40);
  references.data = {};
  const seriesMusic = parseMusic(script);
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
      ...(parseSubtitleMode(script) === 'bilingual' ? { subtitles: 'bilingual' } : {}),
      ...(parseClipAudio(script) !== 'keep' ? { clipAudio: parseClipAudio(script) } : {}),
      ...(parseLearningFx(script).length ? { learningFx: parseLearningFx(script) } : {}),
      ...(music?.url
        ? {
            music: {
              id: uid('music'),
              url: music.url,
              name: music.name || seriesMusic?.file || 'Nhạc nền',
              volume: seriesMusic?.volume ?? DEFAULT_SERIES_MUSIC_VOLUME,
            },
          }
        : {}),
    },
  };
  const fanOut = graph.nodes
    .filter(isGenerator)
    .map(node => edge(references.id, 'image', node.id, 'reference'));
  const newCharacters = graph.cast.filter(character => character.nodes[0].type === 'generateImage');
  const steps = [
    newCharacters.length &&
      `Chạy trước từng node ảnh "Nhân vật" và chọn bản đẹp nhất (bản đó được giữ 🔒 khi Chạy workflow). Nhấp chuột phải vào node → Lưu ảnh nhân vật, rồi đặt file vào thư mục characters/ của series để các tập sau dùng lại cùng khuôn mặt.`,
    'Chạy workflow để tạo mọi cảnh theo thứ tự trên timeline.',
    'Kiểm tra Timeline, thêm ♪ Nhạc nếu muốn, rồi xuất MP4.',
  ]
    .filter(Boolean)
    .map((step, index) => `${index + 1}. ${step}`);
  return {
    nodes: [references, ...graph.nodes, timeline],
    edges: [...graph.edges, ...fanOut],
    groups: [],
    notes: [{ id: uid('note'), x: -280, y: 300, width: 300, height: 190, text: steps.join('\n') }],
    settings: { autoRetry: 0, continueOnError: true },
  };
}
