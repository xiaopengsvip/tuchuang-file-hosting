import test from 'node:test';
import assert from 'node:assert/strict';

import { rateLimitDecision } from '../src/rateLimit.js';

test('rateLimitDecision allows requests within the window limit and blocks excess events', () => {
  const state = new Map();
  const options = { windowMs: 1000, max: 2 };

  const first = rateLimitDecision(state, 'ip:127.0.0.1', 1000, options);
  const second = rateLimitDecision(state, 'ip:127.0.0.1', 1100, options);
  const third = rateLimitDecision(state, 'ip:127.0.0.1', 1200, options);

  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 1);
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 0);
  assert.equal(third.allowed, false);
  assert.equal(third.remaining, 0);
});

test('rateLimitDecision starts a fresh bucket after the window resets', () => {
  const state = new Map();
  const options = { windowMs: 1000, max: 1 };

  assert.equal(rateLimitDecision(state, 'ip:127.0.0.1', 1000, options).allowed, true);
  assert.equal(rateLimitDecision(state, 'ip:127.0.0.1', 1200, options).allowed, false);
  const reset = rateLimitDecision(state, 'ip:127.0.0.1', 2001, options);

  assert.equal(reset.allowed, true);
  assert.equal(reset.count, 1);
  assert.equal(reset.remaining, 0);
});
