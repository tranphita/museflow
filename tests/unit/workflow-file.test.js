import { test } from 'node:test';
import assert from 'node:assert/strict';
import { characterNameFromFile } from '../../scripts/workflow-file.js';

test('photo file names map to character names', () => {
  assert.deepEqual(
    ['Tuấn.jpg', 'Tuấn-2.jpg', 'Tuấn (3).png', 'Lan_2.webp', 'Ms. Anna.png', 'Vy 2.png'].map(
      characterNameFromFile,
    ),
    ['Tuấn', 'Tuấn', 'Tuấn', 'Lan', 'Ms. Anna', 'Vy'],
  );
});
