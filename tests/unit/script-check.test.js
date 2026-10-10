import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRules, rulesFor, checkEpisode, checkSeries, estimateSpeechSeconds } from '../../src/core/script-check.js';
import { workflowFromScript } from '../../src/core/film-graph.js';
import { buildMusePrompt } from '../../src/core/prompts.js';

const bible = `LUẬT:
- Phi Ta: luôn đeo kính gọng vuông màu đen; không để râu
- Hảo: không đeo kính, kể cả kính râm; luôn đeo bông tai ngọc trai
- Chung: không chữ hay logo trên hình

NHÂN VẬT:
- Hảo: woman
- Phi Ta: man
`;

const scene = (body, range = '0:00–0:08') => `${bible}\nCẢNH 1 (${range}): Test\n${body}`;

test('rules split into general and per-character lists', () => {
  const rules = parseRules(bible);
  assert.deepEqual(rules.general, ['không chữ hay logo trên hình']);
  assert.deepEqual(rules.byName['phi ta'], ['luôn đeo kính gọng vuông màu đen', 'không để râu']);
  assert.deepEqual(rulesFor(rules, ['Hảo']), [
    'không chữ hay logo trên hình',
    'Hảo: không đeo kính, kể cả kính râm',
    'Hảo: luôn đeo bông tai ngọc trai',
  ]);
});

test('removing a must-keep item is an error', () => {
  const issues = checkEpisode(scene('Nhân vật: Phi Ta\nPrompt ảnh: Phi Ta tháo kính lau mắt'));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, 'error');
  assert.match(issues[0].message, /tháo kính.*luôn đeo kính/);
});

test('adding a banned item to that character is an error, but not to someone else', () => {
  const issues = checkEpisode(scene('Nhân vật: Hảo, Phi Ta\nPrompt ảnh: Hảo đeo kính râm trên đầu, Phi Ta chỉnh kính'));
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /Hảo đeo kính râm.*không đeo kính/);
});

test('compound words such as camera lens do not count as glasses', () => {
  assert.deepEqual(checkEpisode(scene('Nhân vật: Hảo\nPrompt video: Hảo nhìn vào ống kính và mỉm cười')), []);
});

test('speakers missing from the cast line and names missing from it are reported', () => {
  const issues = checkEpisode(
    scene('Nhân vật: Phi Ta\nPrompt video: Phi Ta gọi món, Hảo cười phía sau\nLời thoại:\n- Hảo: Giỏi quá!'),
  );
  assert.deepEqual(
    issues.map(issue => issue.level),
    ['warn', 'error'],
  );
});

test('long dialogue and scenes over ten seconds are warned', () => {
  const long = checkEpisode(
    scene(
      'Nhân vật: Hảo\nPrompt video: x\nLời thoại:\n- Hảo: Một hai ba bốn năm sáu bảy tám chín mười mười một mười hai mười ba mười bốn mười lăm mười sáu mười bảy mười tám mười chín hai mươi',
      '0:00–0:04',
    ),
  );
  assert.match(long[0].message, /Lời thoại cần khoảng/);
  const tooLong = checkEpisode(scene('Nhân vật: Hảo\nPrompt video: x', '0:00–0:14'));
  assert.match(tooLong[0].message, /tối đa 10 giây/);
  assert.ok(estimateSpeechSeconds('I really like it') > 1.4);
});

test('series checks point out missing rules and photos', () => {
  const notes = checkSeries('NHÂN VẬT:\n- A: x\n- B: y\n\nLUẬT:\n- A: luôn cười', { photoNames: ['A'] });
  assert.deepEqual(
    notes.map(note => note.message.slice(0, 20)),
    ['B chưa có dòng LUẬT.', 'B chưa có ảnh trong '],
  );
});

test('scene rules travel into the generated prompts', () => {
  const workflow = workflowFromScript(scene('Nhân vật: Phi Ta\nPrompt ảnh: Phi Ta cười\nPrompt video: Phi Ta vẫy tay'));
  const video = workflow.nodes.find(node => node.type === 'generateVideo');
  assert.deepEqual(video.data.continuityRules, [
    'không chữ hay logo trên hình',
    'Phi Ta: luôn đeo kính gọng vuông màu đen',
    'Phi Ta: không để râu',
  ]);
  const prompt = buildMusePrompt({
    mediaType: 'video',
    size: '9:16',
    duration: 8,
    prompt: 'x',
    continuityRules: video.data.continuityRules,
  });
  assert.match(prompt, /CONTINUITY RULES — must hold in every frame[^\n]*\n- không chữ hay logo trên hình\n- Phi Ta: luôn đeo kính/);
});
