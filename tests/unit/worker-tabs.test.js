import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMuseUrl, pinnedMuseTabIds, selectableMuseTabs } from '../../src/core/worker-tabs.js';

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
