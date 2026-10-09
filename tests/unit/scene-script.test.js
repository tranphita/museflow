import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneScript } from '../../src/core/scene-script.js';

const script = `CẢNH 1 (0:00–0:07): Mở đầu

Prompt ảnh: A lighthouse at dawn, 16:9

Prompt video: Waves crash slowly
Audio: gentle ocean, seagulls

CẢNH 2 (0:07-0:15): Đêm
Prompt video: Stars spin over the tower

CẢNH 3 (0:15–0:20): Trống
`;

test('parses scenes with prompts, audio direction, ratio and duration', () => {
  const scenes = parseSceneScript(script);
  assert.equal(scenes.length, 2);
  const [first, second] = scenes;
  assert.equal(first.number, 1);
  assert.equal(first.title, 'Mở đầu');
  assert.equal(first.imagePrompt, 'A lighthouse at dawn, 16:9');
  assert.equal(first.videoPrompt, 'Waves crash slowly\n\nAudio direction: gentle ocean, seagulls');
  assert.equal(first.seconds, 7);
  assert.equal(first.size, '16:9');
  assert.equal(second.imagePrompt, '');
  assert.equal(second.seconds, 8);
  assert.equal(second.size, '9:16');
});

test('returns no scenes for unrelated text', () => {
  assert.deepEqual(parseSceneScript('hello world'), []);
});
