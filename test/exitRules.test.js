import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMaxHoldHit } from '../src/execution/exitRules.js';

const HOUR = 60 * 60 * 1000;

test('max hold triggers once the hold time is reached', () => {
  const strat = { max_hold_ms: 4 * HOUR };
  assert.equal(isMaxHoldHit(strat, 1_000, 1_000 + 4 * HOUR - 1), false);
  assert.equal(isMaxHoldHit(strat, 1_000, 1_000 + 4 * HOUR), true);
});

test('accepts opened_at_ms as a string (pg BIGINT)', () => {
  assert.equal(isMaxHoldHit({ max_hold_ms: HOUR }, '1000', 1_000 + HOUR), true);
});

test('disabled when max_hold_ms is 0/missing or strategy is missing', () => {
  assert.equal(isMaxHoldHit({ max_hold_ms: 0 }, 1, 10 * HOUR), false);
  assert.equal(isMaxHoldHit({}, 1, 10 * HOUR), false);
  assert.equal(isMaxHoldHit(null, 1, 10 * HOUR), false);
});

test('a pending Promise (the old un-awaited bug) never counts as a strategy', () => {
  assert.equal(isMaxHoldHit(Promise.resolve({ max_hold_ms: 1 }), 1, 10 * HOUR), false);
});
