import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRateLimited, retryDelayMs } from '../../src/core/rate-limit.js';

test('429 and 503 responses are retried, other errors are not', () => {
  assert.equal(isRateLimited(429), true);
  assert.equal(isRateLimited(503), true);
  assert.equal(isRateLimited(401), false);
  assert.equal(isRateLimited(500), false);
});

test('Retry-After seconds or date is honoured, capped at one minute', () => {
  assert.equal(retryDelayMs(0, '7'), 7000);
  assert.equal(retryDelayMs(0, '600'), 60_000);
  const now = Date.parse('2026-10-10T13:00:00Z');
  assert.equal(retryDelayMs(0, 'Sat, 10 Oct 2026 13:00:12 GMT', now), 12_000);
});

test('without Retry-After the wait doubles from 3s and stays under one minute', () => {
  const noJitter = () => 0;
  assert.equal(retryDelayMs(0, null, 0, noJitter), 3000);
  assert.equal(retryDelayMs(1, null, 0, noJitter), 6000);
  assert.equal(retryDelayMs(3, null, 0, noJitter), 24_000);
  assert.equal(retryDelayMs(10, null, 0, noJitter), 60_000);
  assert.ok(retryDelayMs(0, null, 0, () => 0.999) < 4000);
});
