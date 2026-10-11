import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEW_SIDE_CHAT_URL,
  isMuseUrl,
  pinnedMuseTabIds,
  selectableMuseTabs,
  workerChatUrl,
  workerWindowBounds,
} from '../../src/core/worker-tabs.js';

test('only muse.ai pages count as Muse tabs', () => {
  assert.equal(isMuseUrl('https://muse.ai/chat'), true);
  assert.equal(isMuseUrl('https://www.muse.ai/thread/1'), true);
  assert.equal(isMuseUrl('https://muse.ai.evil.com/'), false);
  assert.equal(isMuseUrl('https://evil.com/?https://muse.ai/'), false);
  assert.equal(isMuseUrl('chrome://newtab/'), false);
  assert.equal(isMuseUrl(undefined), false);
});

test('Muse tabs pinned by workers are found from the worker tab URLs', () => {
  const app = 'chrome-extension://abc/app.html';
  const tabs = [
    { id: 30, url: `${app}?worker=1&muse=7` },
    { id: 31, url: `${app}?worker=2&muse=8` },
    { id: 20, url: app },
    { id: 7, url: 'https://muse.ai/' },
  ];
  assert.deepEqual([...pinnedMuseTabIds(tabs, app)].sort(), [7, 8]);
});

test('the main tab skips pinned Muse tabs and a worker only uses its own', () => {
  const muse = [{ id: 7 }, { id: 8 }, { id: 9 }];
  assert.deepEqual(selectableMuseTabs(muse, { pinnedIds: new Set([7, 8]) }), [{ id: 9 }]);
  assert.deepEqual(selectableMuseTabs(muse, { pinnedId: 8, pinnedIds: new Set([7, 8]) }), [{ id: 8 }]);
  assert.deepEqual(selectableMuseTabs(muse, {}), muse);
});

test('workers open a fresh side chat instead of the shared Muse main chat', () => {
  assert.equal(workerChatUrl('https://muse.ai/'), NEW_SIDE_CHAT_URL);
  assert.equal(workerChatUrl('https://muse.ai'), NEW_SIDE_CHAT_URL);
  assert.equal(workerChatUrl('https://www.muse.ai/?ref=x'), NEW_SIDE_CHAT_URL);
  assert.equal(workerChatUrl('https://evil.com/thread/new'), NEW_SIDE_CHAT_URL);
  assert.equal(workerChatUrl(undefined), NEW_SIDE_CHAT_URL);
  assert.equal(workerChatUrl('https://muse.ai/thread/new'), 'https://muse.ai/thread/new');
  assert.equal(workerChatUrl('https://muse.ai/thread/abc'), 'https://muse.ai/thread/abc');
});

test('worker windows tile the screen without overlapping', () => {
  const screen = { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040 };
  const eight = Array.from({ length: 8 }, (_, index) => workerWindowBounds(index + 1, 8, screen));
  assert.deepEqual(eight[0], { left: 0, top: 0, width: 480, height: 520 });
  assert.deepEqual(eight[7], { left: 1440, top: 520, width: 480, height: 520 });
  for (const a of eight)
    for (const b of eight)
      if (a !== b)
        assert.ok(
          a.left + a.width <= b.left ||
            b.left + b.width <= a.left ||
            a.top + a.height <= b.top ||
            b.top + b.height <= a.top,
        );
  assert.deepEqual(workerWindowBounds(3, 3, screen), { left: 1120, top: 0, width: 560, height: 820 });
});

test('worker windows follow a screen that does not start at the origin', () => {
  const screen = { availLeft: -1920, availTop: 40, availWidth: 1920, availHeight: 1000 };
  assert.deepEqual(workerWindowBounds(2, 2, screen), { left: -1360, top: 40, width: 560, height: 820 });
});
