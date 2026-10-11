import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('../../bridge/refusal.js', import.meta.url), 'utf8'), context);
const { isRefusalContext, isClearRefusal, isAwaitingApproval } = context.MusetaRefusal;

test('detects English refusals', () => {
  assert.equal(isRefusalContext("I'm sorry, but I can't create that video."), true);
  assert.equal(isRefusalContext('This request violates our content policy.'), true);
});

test('detects Vietnamese refusals that mention the scene', () => {
  const reply = 'Mình không thể tạo cảnh này. Bạn có muốn mình tạo bản tương đương bám theo kịch bản không?';
  assert.equal(isRefusalContext(reply), true);
  assert.equal(isClearRefusal(reply), true);
});

test('ignores normal progress messages', () => {
  assert.equal(isRefusalContext('Here is your video of a fox running through snow.'), false);
  assert.equal(isClearRefusal('Đây là video của bạn.'), false);
});

test('detects Muse pausing to ask for approval before generating', () => {
  for (const reply of [
    'Mình sẽ vẽ cảnh 2: Mommy dạy mẫu câu bên bàn ăn. Duyệt thì mình tạo luôn nhé.',
    'Bạn xác nhận giúp mình bố cục này được không?',
    'Here is my plan for scene 3. Shall I go ahead and generate it?',
    'Let me know if you approve and I will create the video.',
  ])
    assert.equal(isAwaitingApproval(reply), true, reply);
});

test('ignores finished replies and refusals when checking for approval requests', () => {
  assert.equal(isAwaitingApproval('Đây là ảnh của bạn.'), false);
  assert.equal(isAwaitingApproval(''), false);
  assert.equal(
    isAwaitingApproval(
      'Mình không thể tạo cảnh này. Bạn có muốn mình tạo bản tương đương bám theo kịch bản không?',
    ),
    false,
  );
});
