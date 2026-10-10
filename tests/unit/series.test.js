import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  characterNameFromFile,
  describeEpisode,
  episodeNumber,
  episodeScript,
  groupCharacterFiles,
  humanizeSlug,
  isEpisodeFile,
  parseEpisodeTitle,
  parseSeriesName,
} from '../../src/core/series.js';

test('episode files and numbers are recognised', () => {
  assert.equal(isEpisodeFile('ep01-chao-hoi.txt'), true);
  assert.equal(isEpisodeFile('_series.txt'), false);
  assert.equal(isEpisodeFile('notes.txt'), false);
  assert.equal(episodeNumber('ep12-x.txt'), 12);
  assert.equal(humanizeSlug('ep03-di-sieu-thi.txt'), 'Di sieu thi');
});

test('series and episode titles come from their header lines', () => {
  assert.equal(parseSeriesName('TÊN BỘ: Vợ dạy chồng tiếng Anh\n\nNHÂN VẬT:'), 'Vợ dạy chồng tiếng Anh');
  assert.equal(parseEpisodeTitle('TIÊU ĐỀ: Anh nói sai rồi!\n\nCẢNH 1 (0:00–0:08): x'), 'Anh nói sai rồi!');
  assert.equal(parseEpisodeTitle('CẢNH 1 (0:00–0:08): x'), '');
});

test('describeEpisode counts scenes, length and dialogue lines', () => {
  const bible = 'NHÂN VẬT:\n- Hảo: a\n- Phi Ta: b';
  const episode = `TIÊU ĐỀ: Demo

CẢNH 1 (0:00–0:08): One
Prompt video: x
Lời thoại:
- Hảo: Hi
- Phi Ta: Hello

CẢNH 2 (0:08–0:14): Two
Prompt video: y`;
  assert.deepEqual(describeEpisode('ep02-demo.txt', episode, bible), {
    number: 2,
    title: 'Demo',
    scenes: 2,
    seconds: 14,
    lines: 2,
  });
  assert.match(episodeScript(bible, episode), /^NHÂN VẬT:[\s\S]*TIÊU ĐỀ: Demo/);
});

test('character photos group by name and keep numeric order', () => {
  const files = ['Hảo-2.jpg', 'Hảo-1.jpg', 'Phi Ta-1.jpg', 'notes.txt', 'Hảo-10.jpg'].map(name => ({ name }));
  const grouped = groupCharacterFiles(files);
  assert.deepEqual(Object.keys(grouped), ['Hảo', 'Phi Ta']);
  assert.deepEqual(
    grouped['Hảo'].map(file => file.name),
    ['Hảo-1.jpg', 'Hảo-2.jpg', 'Hảo-10.jpg'],
  );
  assert.equal(characterNameFromFile('Ms. Anna (2).png'), 'Ms. Anna');
});
