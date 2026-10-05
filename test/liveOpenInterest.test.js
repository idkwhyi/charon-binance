import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOpenInterestWithRetry } from '../src/enrichment/binance.js';
import { processScanCycle } from '../src/pipeline/orchestrator.js';
import { installFakePool } from './helpers/fakePool.js';

const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

test('live OI fetch: one retry, then null', async () => {
  let n = 0;
  const flaky = async () => { if (++n === 1) throw new Error('timeout'); return { openInterest: '1234.5' }; };
  assert.equal(await fetchOpenInterestWithRetry('AUSDT', { fetch: flaky, pauseMs: 0 }), 1234.5);
  assert.equal(n, 2);

  let m = 0;
  const down = async () => { m++; throw new Error('503'); };
  assert.equal(await quiet(() => fetchOpenInterestWithRetry('AUSDT', { fetch: down, pauseMs: 0 })), null);
  assert.equal(m, 2, 'exactly one retry');
  assert.equal(await quiet(() => fetchOpenInterestWithRetry('AUSDT', { fetch: async () => ({}), pauseMs: 0 })), null, 'malformed response');
});

test('live: candidate without OI is rejected and logged to signal_events as OI_UNAVAILABLE', async () => {
  const strat = { id: 'oi_live', signal_types: 'volume_spike', leverage: 5, tp_percent: 2, sl_percent: -1.5, min_open_interest_usdt: 10_000_000, max_open_positions: 3 };
  const events = [];
  installFakePool((text, p) => {
    if (/key = 'active_strategy'/.test(text)) return [{ value: 'oi_live' }];
    if (/LIKE 'strategy:%'/.test(text)) return [{ key: 'strategy:oi_live', value: strat }];
    if (/INSERT INTO candidates/.test(text)) return [{ id: 7 }];
    if (/INSERT INTO signal_events/.test(text)) events.push({ code: p[7], stage: p[5], outcome: p[6] });
    if (/virtual_balance/.test(text)) return [{ balance_usdt: 1000, available_balance: 1000 }];
    return [];
  });
  const raw = {
    symbol: 'AUSDT', signalType: 'volume_spike', direction: 'LONG', signalMeta: {},
    ticker: { lastPrice: '100', quoteVolume: '90000000', priceChangePercent: '5' },
    klines1h: [], klines15m: [{ openTime: 0, closeTime: 899_999, close: 100, volume: 1 }],
    fundingRate: 0, openInterest: null, detectedAt: Date.now(),
  };
  await quiet(() => processScanCycle([raw]));
  assert.deepEqual(events.filter(e => e.stage === 'pipeline'), [{ code: 'OI_UNAVAILABLE', stage: 'pipeline', outcome: 'rejected' }]);
});
