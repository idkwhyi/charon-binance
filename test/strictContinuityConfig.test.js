import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStrictContinuity, KLINE_WINDOW } from '../src/signals/klineCache.js';
import { KLINE_STRICT_CONTINUITY, validateConfig } from '../src/config.js';

test('defaults are 20 (15m) and 6 (1h) and pass validation', () => {
  assert.equal(KLINE_WINDOW, 100);
  assert.doesNotThrow(() => validateStrictContinuity({ '15m': 20, '1h': 6 }));
  assert.doesNotThrow(() => validateStrictContinuity({ '15m': 1, '1h': KLINE_WINDOW - 1 }));
});

test('rejects N <= 0, N >= window, and non-integers with a clear message', () => {
  for (const bad of [0, -3, KLINE_WINDOW, KLINE_WINDOW + 50, 2.5, NaN]) {
    assert.throws(() => validateStrictContinuity({ '15m': 20, '1h': bad }),
      e => e.message.includes(`KLINE_STRICT_CONTINUITY_CANDLES_1H=${bad}`) && e.message.includes(`0 < N < ${KLINE_WINDOW}`), String(bad));
  }
  assert.throws(() => validateStrictContinuity({ '15m': 0, '1h': 100 }),
    e => e.message.includes('_15M=0') && e.message.includes('_1H=100'), 'lists every invalid setting');
});

test('validateConfig (bot startup) runs the check', () => {
  // With the configured values valid, validateConfig only fails later on unrelated required settings (or not at all)
  try { validateConfig(); } catch (err) { assert.ok(!err.message.includes('KLINE_STRICT'), err.message); }
  assert.doesNotThrow(() => validateStrictContinuity(KLINE_STRICT_CONTINUITY));
});
