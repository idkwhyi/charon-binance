import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signalDedupKey } from '../src/pipeline/dedup.js';

const sig = (overrides = {}) => ({
  symbol: 'BTCUSDT',
  direction: 'LONG',
  signalType: 'extreme_ob',
  klines15m: [{ closeTime: 1_000 }, { closeTime: 2_000 }],
  detectedAt: 5_000,
  ...overrides,
});

test('same setup on the same 15m candle gets the same key across scans', () => {
  assert.equal(signalDedupKey(sig({ detectedAt: 1 })), signalDedupKey(sig({ detectedAt: 999_999 })));
});

test('a new 15m candle produces a new key', () => {
  const next = sig({ klines15m: [{ closeTime: 2_000 }, { closeTime: 3_000 }] });
  assert.notEqual(signalDedupKey(sig()), signalDedupKey(next));
});

test('key separates symbol and direction', () => {
  assert.notEqual(signalDedupKey(sig()), signalDedupKey(sig({ direction: 'SHORT' })));
  assert.notEqual(signalDedupKey(sig()), signalDedupKey(sig({ symbol: 'ETHUSDT' })));
});

test('falls back to the 15m bucket of detectedAt without klines', () => {
  const a = signalDedupKey(sig({ klines15m: [], detectedAt: 15 * 60_000 }));
  const b = signalDedupKey(sig({ klines15m: [], detectedAt: 15 * 60_000 + 60_000 }));
  const c = signalDedupKey(sig({ klines15m: [], detectedAt: 30 * 60_000 }));
  assert.equal(a, b);
  assert.notEqual(a, c);
});
