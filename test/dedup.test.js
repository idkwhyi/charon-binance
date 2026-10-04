import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signalDedupKey, seenSignals, checkAndMarkSeen, markDetectorOutcome } from '../src/pipeline/dedup.js';

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


const k15 = (closeTime) => [{ closeTime: closeTime - 900_000 }, { closeTime }];
const entering = (closeTime) => ({ symbol: 'BTCUSDT', direction: 'LONG', signalType: 'extreme_ob', klines15m: k15(closeTime) });

test('WATCH (zone / confirmation score) is not marked, so the same candle can still enter', () => {
  seenSignals.clear();
  const watch = { type: 'extreme_ob_watch', direction: 'LONG', meta: { waitingFor: 'price_in_ob_zone' } };
  assert.equal(markDetectorOutcome('BTCUSDT', watch, k15(1_800_000), 0), false);
  assert.equal(checkAndMarkSeen(entering(1_800_000), 0), false, 'entry not blocked by an earlier WATCH');
});

test('a detector reject (e.g. funding) is marked: the setup cannot enter later on the same candle', () => {
  seenSignals.clear();
  const funding = { type: 'extreme_ob_reject', direction: 'LONG', meta: { reasonCode: 'funding_filter' } };
  assert.equal(markDetectorOutcome('BTCUSDT', funding, k15(1_800_000), 0), true);
  assert.equal(checkAndMarkSeen(entering(1_800_000), 30_000), true, 'blocked on the same candle');
  assert.equal(checkAndMarkSeen(entering(2_700_000), 30_000), false, 'next candle is evaluated fresh');
});

test('a reject only blocks its own direction; ranging (no direction) marks nothing', () => {
  seenSignals.clear();
  markDetectorOutcome('BTCUSDT', { type: 'extreme_ob_reject', direction: 'SHORT', meta: {} }, k15(1_800_000), 0);
  assert.equal(checkAndMarkSeen(entering(1_800_000), 0), false);
  seenSignals.clear();
  assert.equal(markDetectorOutcome('BTCUSDT', { type: 'extreme_ob_reject', direction: null, meta: { reasonCode: 'ranging_market' } }, k15(1_800_000), 0), false);
  assert.equal(seenSignals.size, 0);
});

test('pipeline check-and-mark: second sighting on the same candle is a duplicate', () => {
  seenSignals.clear();
  assert.equal(checkAndMarkSeen(entering(1_800_000), 0), false);
  assert.equal(checkAndMarkSeen(entering(1_800_000), 10_000), true);
});
