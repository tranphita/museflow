export const PAUSE_KINDS = new Set(['credits', 'signed-out', 'tts-key']);
export const NO_RETRY_KINDS = new Set(['refused', 'script']);

const SEVERITY = [
  'credits',
  'signed-out',
  'tts-key',
  'script',
  'refused',
  'bridge',
  'timeout',
  'export',
  'unknown',
  'stopped',
];
// Order matters: a refusal quotes arbitrary chat text, so it is matched before words like "log in".
const PATTERNS = [
  ['stopped', /stopped by user|aborterror/i],
  ['refused', /^muse could not generate this scene/i],
  ['credits', /insufficient (?:image )?credits|out of credits/i],
  ['signed-out', /sign in|log in|signed out/i],
  ['tts-key', /tvoiceai api key|voiceover service error \(http 40[13]\)/i],
  [
    'script',
    /connect a prompt|prompt is empty|end-frame continuity|no scenes found|could not open this episode/i,
  ],
  [
    'bridge',
    /message box is (?:not visible|unsupported)|could not attach its page bridge|did not accept the prompt|did not confirm the prompt submission|bridge did not answer|chat is not ready|upload control was not found|did not confirm \d+ reference image/i,
  ],
  ['timeout', /timed out|watchdog/i],
  ['export', /mp4|ffmpeg|timeline clip/i],
];

export function classifyError(message) {
  const text = String(message || '');
  return PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] || 'unknown';
}

export function worstKind(kinds) {
  return SEVERITY.find(kind => kinds.includes(kind)) || 'unknown';
}
