import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('../../bridge/refusal.js', import.meta.url), 'utf8'), context);
const { isRefusalContext, isClearRefusal } = context.MusetaRefusal;

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
