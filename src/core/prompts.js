const compositionBySize = {
  '16:9': 'Use a wide landscape composition.',
  '9:16': 'Use a tall portrait composition.',
  '1:1': 'Use a square composition.',
  '4:3': 'Use a standard landscape composition.',
};

const CONTINUITY_LOCK =
  'CONTINUITY LOCK: Attached image 1 is the exact final frame of the previous Timeline clip. Use image 1 as the exact first frame of this video: preserve its subject identity, pose, position, camera angle, crop, lighting, and background. Continue motion naturally from that precise moment. No reset, jump, flash, dissolve, or scene change at the start.';
const AUDIO_REQUIRED =
  'AUDIO IS REQUIRED: Return a video with audible, synchronized sound; do not make a silent clip. Follow the requested audio direction and make its music and sound effects clearly audible. Do not add spoken dialogue unless the prompt asks for it.';
const PROMPT_FIDELITY =
  'PROMPT FIDELITY: Follow the provided prompt closely and depict its requested characters, actions, setting, sequence, mood, and visual details. Keep the main action clear and recognizable throughout the clip. Do not substitute a different scene, omit requested actions, or add unrelated events. Use the connected reference images to preserve subject identity and appearance.';
const SAFE_RETRY =
  "SAFE EQUIVALENT RETRY: The previous version could not be generated. Create a close, allowed alternative for the same scene now. Stay faithful to the script's story purpose, characters, relationship, setting, action, mood, visual style, framing, continuity, and requested duration/aspect ratio. Change only the specific detail that prevents generation, replacing it with the nearest safe equivalent. Keep this scene in the story; do not skip it or change what it needs to accomplish. Do not ask a follow-up question or ask permission; generate the alternative in this attempt. Follow all content and safety rules.";

export function sizeInstruction(size) {
  return `Output aspect ratio: ${size}. Match this frame shape exactly. ${compositionBySize[size] || 'Use a standard portrait composition.'}`;
}

export function buildMusePrompt({
  mediaType,
  size,
  duration,
  prompt,
  negativePrompt = '',
  referenceCount = 0,
  continuityFrame = false,
  again = false,
  characterNames = [],
  nextShot = '',
}) {
  const plural = referenceCount === 1 ? '' : 's';
  const characterLock = characterLockInstruction(characterNames, { continuityFrame });
  if (mediaType === 'video') {
    const sections = [
      `Create a ${size} aspect ratio video clip, ${duration} seconds long. ${sizeInstruction(size)}`,
      characterLock,
      AUDIO_REQUIRED,
      continuityFrame && CONTINUITY_LOCK,
      referenceCount &&
        `Use the attached reference image${plural} as visual guidance${continuityFrame ? ' while keeping image 1 as the exact opening frame.' : '.'}`,
      `Prompt: ${prompt}`,
      nextShot &&
        `ENDING: Finish on a steady, well-composed frame that flows naturally into the next shot (${nextShot}). Avoid an abrupt cut, fade, or camera jump in the final second.`,
      negativePrompt && `Avoid: ${negativePrompt}`,
      again && PROMPT_FIDELITY,
    ];
    return sections.filter(Boolean).join('\n\n');
  }
  const sections = [
    characterLock,
    prompt,
    referenceCount &&
      `Use the attached reference image${plural} as visual guidance; follow the prompt while preserving relevant subject details.`,
    sizeInstruction(size),
    negativePrompt && `Avoid the following (negative prompt): ${negativePrompt}`,
  ];
  return sections.filter(Boolean).join('\n\n');
}

function imageList(indexes) {
  const labels = indexes.map(index => `#${index + 1}`);
  return labels.length === 1
    ? `Image ${labels[0]} is a real photo`
    : `Images ${labels.join(', ')} are real photos`;
}

export function characterLockInstruction(names, { continuityFrame = false } = {}) {
  const people = new Map();
  names.forEach((name, index) => {
    if (name) people.set(name, [...(people.get(name) || []), index]);
  });
  if (!people.size) return '';
  const guides = names.some((name, index) => !name && !(continuityFrame && index === 0));
  return [
    'IDENTITY LOCK — highest priority, overrides every other instruction:',
    ...[...people].map(([name, indexes]) => `- ${imageList(indexes)} of ${name}.`),
    '- These are real people. Recreate each face exactly as in their own photos: same face shape, jawline, eyes, eyelids, eyebrows, nose, lips, skin tone, hairline and hairstyle, and glasses where shown. Same apparent age. No beautifying, stylizing, makeup or feature changes, and never mix faces between people.',
    '- Faces must never look rounder, wider, puffier or heavier than in the photos: keep the same cheek and jaw width, no double chin.',
    "- Bodies: keep each person's natural, slim, well-proportioned figure exactly as in the photos — never heavier, wider, broader or bulkier — with relaxed, natural posture.",
    '- Film people with a 50–85 mm portrait lens look from a natural distance; no wide-angle or close-up lens distortion that widens faces.',
    guides &&
      '- Any other attached image is a composition guide only: use it for setting, framing and pose, never for faces or bodies.',
    continuityFrame &&
      '- If the opening frame shows a slightly different face, correct it to match the identity photos within the first moments.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildRefusalRetryPrompt(prompt) {
  return `${prompt}\n\n${SAFE_RETRY}`;
}

export function isRatioMismatch(width, height, size) {
  if (!width || !height) return false;
  const [w, h] = String(size || '1:1')
    .split(':')
    .map(Number);
  const expected = w > 0 && h > 0 ? w / h : 1;
  return Math.abs(Math.log(width / height / expected)) > 0.09;
}
