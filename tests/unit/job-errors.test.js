import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, worstKind, PAUSE_KINDS, NO_RETRY_KINDS } from '../../src/core/job-errors.js';

const cases = [
  ['Generation stopped by user.', 'stopped'],
  ['Muse could not generate this scene: Mình không thể tạo cảnh này, please log in again', 'refused'],
  ['Muse account has insufficient image credits.', 'credits'],
  ['Open Muse.ai and sign in, then retry.', 'signed-out'],
  ['The Muse tab for this worker was closed. Open Muse.ai and sign in, then retry.', 'signed-out'],
  ['Muse is signed out. Open Muse.ai and sign in, then retry.', 'signed-out'],
  ['Paste your tvoiceai API key in Settings → Voiceover, press Save, then run again.', 'tts-key'],
  ['Voiceover service error (HTTP 401): invalid key', 'tts-key'],
  ['Generate Video n1: connect a Prompt, Text Append, or Text Merge node first.', 'script'],
  ['End-frame continuity for n2 needs the previous Timeline clip to be generated successfully', 'script'],
  ['Could not open this episode.', 'script'],
  ['Muse message box is not visible. Open the chat composer and retry.', 'bridge'],
  ['Muse tab found, but Museta could not attach its page bridge: x', 'bridge'],
  ['Muse did not confirm the prompt submission. Check the chat box and try again', 'bridge'],
  ['Muse chat is not ready after 90 s.', 'bridge'],
  ['Muse did not confirm 2 reference images in the chat composer (upload input accepts: image/*)', 'bridge'],
  ['Timed out waiting for a new Muse video attachment. Prompt was submitted once', 'timeout'],
  ['Timed out waiting for the voiceover.', 'timeout'],
  ['FFmpeg produced an empty MP4 file.', 'export'],
  ['Something odd happened', 'unknown'],
  ['', 'unknown'],
];

test('error messages from the bridge, runner and services are classified', () => {
  for (const [message, kind] of cases) assert.equal(classifyError(message), kind, message);
});

test('the most serious kind wins and kinds are grouped by how the queue reacts', () => {
  assert.equal(worstKind(['timeout', 'credits', 'bridge']), 'credits');
  assert.equal(worstKind(['timeout', 'refused']), 'refused');
  assert.equal(worstKind([]), 'unknown');
  assert.deepEqual([...PAUSE_KINDS], ['credits', 'signed-out', 'tts-key']);
  assert.deepEqual([...NO_RETRY_KINDS], ['refused', 'script']);
});
