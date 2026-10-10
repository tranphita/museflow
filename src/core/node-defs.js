export const nodeDefs = {
  prompt: { title: 'Prompt', outputs: [{ id: 'text', label: 'văn bản', type: 'text' }] },
  negativePrompt: {
    title: 'Negative Prompt',
    outputs: [{ id: 'text', label: 'negative', type: 'negative' }],
  },
  textAppend: {
    title: 'Text Append',
    inputs: [{ id: 'text', label: 'văn bản', type: 'text' }],
    outputs: [{ id: 'text', label: 'văn bản', type: 'text' }],
  },
  textConcat: {
    title: 'Text Merge',
    inputs: [{ id: 'text', label: 'văn bản', type: 'text' }],
    outputs: [{ id: 'text', label: 'văn bản', type: 'text' }],
  },
  imageInput: { title: 'Image Input', outputs: [{ id: 'image', label: 'ảnh', type: 'image' }] },
  references: {
    title: 'References',
    inputs: Array.from({ length: 8 }, (_, i) => ({
      id: `reference${i + 1}`,
      label: `ảnh ${i + 1}`,
      type: 'image',
    })),
    outputs: [{ id: 'image', label: 'ảnh', type: 'image' }],
  },
  generateImage: {
    title: 'Generate Image',
    inputs: [
      { id: 'prompt', label: 'prompt', type: 'text' },
      { id: 'negative', label: 'negative', type: 'negative' },
      { id: 'reference', label: 'tham chiếu', type: 'image' },
    ],
    outputs: [{ id: 'image', label: 'ảnh', type: 'image' }],
  },
  generateVideo: {
    title: 'Generate Video',
    inputs: [
      { id: 'prompt', label: 'prompt', type: 'text' },
      { id: 'negative', label: 'negative', type: 'negative' },
      { id: 'reference', label: 'tham chiếu', type: 'image' },
      { id: 'voice', label: 'giọng đọc', type: 'audio' },
    ],
    outputs: [
      { id: 'video', label: 'video', type: 'video' },
      { id: 'endFrame', label: 'khung cuối', type: 'image' },
    ],
  },
  timeline: {
    title: 'Timeline',
    inputs: Array.from({ length: 6 }, (_, i) => ({
      id: `clip${i + 1}`,
      label: `clip ${i + 1}`,
      type: 'video',
    })),
    outputs: [],
  },
  voiceover: {
    title: 'Voiceover',
    inputs: [{ id: 'text', label: 'văn bản', type: 'text' }],
    outputs: [{ id: 'audio', label: 'giọng đọc', type: 'audio' }],
  },
  imageResize: {
    title: 'Image Resize',
    inputs: [{ id: 'image', label: 'ảnh', type: 'image' }],
    outputs: [{ id: 'image', label: 'ảnh', type: 'image' }],
  },
  preview: { title: 'Preview', inputs: [{ id: 'media', label: 'media', type: 'media' }] },
};

export function uid(prefix = 'id') {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function starter() {
  return {
    nodes: [
      {
        id: 'prompt-1',
        type: 'prompt',
        x: 90,
        y: 110,
        data: { text: 'A cinematic portrait of a futuristic Vietnamese woman, neon rain, detailed face' },
      },
      {
        id: 'gen-1',
        type: 'generateImage',
        x: 450,
        y: 105,
        data: { model: 'muse-image', size: '1:1', status: 'idle' },
      },
      { id: 'preview-1', type: 'preview', x: 820, y: 110, data: {} },
    ],
    edges: [
      { id: 'e1', source: 'prompt-1', sourcePort: 'text', target: 'gen-1', targetPort: 'prompt' },
      { id: 'e2', source: 'gen-1', sourcePort: 'image', target: 'preview-1', targetPort: 'media' },
    ],
  };
}

export function canConnectTypes(outputType, inputType) {
  return outputType === inputType || (inputType === 'media' && ['image', 'video'].includes(outputType));
}
export function isMultiInput(nodeType, portId) {
  return (
    (['generateImage', 'generateVideo'].includes(nodeType) && ['prompt', 'reference'].includes(portId)) ||
    (nodeType === 'references' && portId.startsWith('reference')) ||
    (nodeType === 'generateVideo' && portId === 'voice') ||
    (nodeType === 'textConcat' && portId === 'text')
  );
}
export function makeNode(type, x, y) {
  const data =
    type === 'prompt'
      ? { text: 'Describe what you want Muse to generate...' }
      : type === 'negativePrompt'
        ? { text: 'blurry, low quality, distorted anatomy, extra fingers, text, watermark' }
        : type === 'imageInput'
          ? {}
          : type === 'generateVideo'
            ? { model: 'muse-video', size: '16:9', duration: 5, continuity: false, status: 'idle' }
            : {};
  return { id: uid(type), type, x, y, data };
}

export const DEFAULT_VOICE_ID = 'VIENEU_CLONE_1788933824331';

export const GENERATOR_TYPES = ['generateImage', 'generateVideo'];

export function isGenerator(node) {
  return GENERATOR_TYPES.includes(node?.type);
}
