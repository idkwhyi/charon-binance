import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { findGaps, latestClosedOpenTime, INTERVAL_MS } from '../src/signals/klineCache.js';
import { ensureContinuous, backfillAll, applyClosedKline, scanSignals, setCycleHandler, _klineCacheForTest } from '../src/signals/scanner.js';
import { installFakePool } from './helpers/fakePool.js';

const M15 = INTERVAL_MS['15m'];
const H1 = INTERVAL_MS['1h'];
const c = (openTime, step, extra = {}) => ({ openTime, open: 100, high: 100.1, low: 99.9, close: 100, volume: 1, closeTime: openTime + step - 1, quoteVolume: 100, ...extra });
const range = (from, to, step, extra) => { const out = []; for (let t = from; t <= to; t += step) out.push(c(t, step, extra?.(t))); return out; };

test('findGaps reports holes between candles and a stale tail', () => {
  const ks = [c(0, M15), c(M15, M15), c(4 * M15, M15)];
  assert.deepEqual(findGaps(ks, M15), [{ afterOpenTime: M15, fromOpenTime: 2 * M15, toOpenTime: 3 * M15, count: 2 }]);
  const now = 7 * M15 + 10; // latest closed candle opened at 6*M15
  const tail = findGaps(ks, M15, now).at(-1);
  assert.deepEqual(tail, { afterOpenTime: 4 * M15, fromOpenTime: 5 * M15, toOpenTime: 6 * M15, count: 2 });
  assert.deepEqual(findGaps(range(0, 6 * M15, M15), M15, now), []);
  assert.equal(latestClosedOpenTime(M15, now), 6 * M15);
});

// Exchange stub: serves `truth` candles honoring startTime/limit, optionally with permanent holes
function stubExchange(truthByInterval, { onKlines } = {}) {
  const original = axios.get;
  const calls = [];
  axios.get = async (url, { params = {} } = {}) => {
    if (url.includes('/klines')) {
      calls.push(params);
      onKlines?.(params);
      const rows = (truthByInterval[params.interval] || [])
        .filter(k => params.startTime === undefined || k.openTime >= params.startTime)
        .slice(params.startTime === undefined ? -params.limit : 0, params.startTime === undefined ? undefined : params.limit);
      return { data: rows.map(k => [k.openTime, String(k.open), String(k.high), String(k.low), String(k.close), String(k.volume), k.closeTime, String(k.quoteVolume)]) };
    }
    if (url.includes('premiumIndex')) return { data: { lastFundingRate: '0', markPrice: '100' } };
    if (url.includes('openInterest')) return { data: { openInterest: '1' } };
    return { data: { lastPrice: '100', quoteVolume: '1' } };
  };
  return { calls, restore: () => { axios.get = original; } };
}

const NOW = Date.UTC(2026, 9, 4, 12, 0, 30); // 30s after 12:00 — the 11:45 15m and 11:00 1h candles just closed
const last15 = latestClosedOpenTime(M15, NOW);
const last1h = latestClosedOpenTime(H1, NOW);

test('disconnect/reconnect: candles that closed while offline are backfilled from the last cached close', async () => {
  const truth15 = range(last15 - 59 * M15, last15, M15);
  const cache = _klineCacheForTest();
  cache.clear();
  // cache stopped 4 candles before "now" (WebSocket was down for an hour)
  cache.set('GAPUSDT', { '1h': range(last1h - 59 * H1, last1h, H1), '15m': truth15.slice(0, -4) });
  const { calls, restore } = stubExchange({ '15m': truth15 });
  try {
    await backfillAll(NOW);
  } finally { restore(); }

  const ks = cache.get('GAPUSDT')['15m'];
  assert.deepEqual(findGaps(ks, M15, NOW), []);
  assert.equal(ks.at(-1).openTime, last15);
  assert.equal(new Set(ks.map(k => k.openTime)).size, ks.length, 'no duplicates');
  assert.equal(calls.length, 1, 'only the stale series was fetched');
  assert.equal(calls[0].startTime, truth15.at(-5).openTime, 'starts at the openTime of the last cached close');
  assert.ok(calls[0].limit <= 10, `limit sized to the hole, got ${calls[0].limit}`);
});

test('a hole in the middle (stream skipped candles, later ones arrived) is filled', async () => {
  const truth15 = range(last15 - 59 * M15, last15, M15);
  const cache = _klineCacheForTest();
  cache.clear();
  const holed = truth15.filter((k, i) => i < 50 || i > 52);
  cache.set('MIDUSDT', { '1h': [], '15m': holed });
  const { restore } = stubExchange({ '15m': truth15 });
  try {
    assert.deepEqual(await ensureContinuous('MIDUSDT', '15m', NOW), []);
  } finally { restore(); }
  assert.equal(cache.get('MIDUSDT')['15m'].length, 60);
});

test('a closed candle arriving over WS after a backfill does not duplicate', async () => {
  const truth15 = range(last15 - 59 * M15, last15, M15);
  const cache = _klineCacheForTest();
  cache.clear();
  cache.set('DUPUSDT', { '1h': [], '15m': truth15.slice(0, -1) });
  const { restore } = stubExchange({ '15m': truth15 });
  try { await ensureContinuous('DUPUSDT', '15m', NOW); } finally { restore(); }
  applyClosedKline({ symbol: 'DUPUSDT', interval: '15m', candle: truth15.at(-1) });
  const ks = cache.get('DUPUSDT')['15m'];
  assert.equal(ks.filter(k => k.openTime === last15).length, 1);
});

test('if REST also has the hole, the symbol is skipped this cycle and DATA_GAP is recorded', async () => {
  // spike on the latest closed 15m candle would trigger volume_spike if the symbol were scanned
  const truth15 = range(last15 - 59 * M15, last15, M15, t => (t === last15 ? { volume: 1000 } : {}))
    .filter(k => k.openTime !== last15 - 5 * M15); // permanent hole on the exchange side too
  const truth1h = range(last1h - 59 * H1, last1h, H1);
  const events = [];
  installFakePool((text, params) => {
    if (/INSERT INTO signal_events/.test(text)) { events.push(params); return []; }
    if (/key = \$1/.test(text) && params[0] === 'active_strategy') return [{ value: 'gap_test' }];
    if (/LIKE 'strategy:%'/.test(text)) return [{ key: 'strategy:gap_test', value: { signal_types: 'volume_spike', min_volume_spike_ratio: 3 } }];
    if (/key = \$1/.test(text) && params[0] === 'strategy:gap_test') return [{ value: { signal_types: 'volume_spike', min_volume_spike_ratio: 3 } }];
    if (/key = \$1/.test(text)) return [{ value: ['HOLEUSDT'] }]; // watchlist (JSONB array, as pg returns it)
    return [];
  });
  _klineCacheForTest().clear();
  const { restore } = stubExchange({ '15m': truth15, '1h': truth1h });
  const seen = [];
  setCycleHandler(async s => { seen.push(...s); });
  const origLog = console.log; console.log = () => {};
  const realNow = Date.now; Date.now = () => NOW;
  try {
    await scanSignals();
  } finally {
    Date.now = realNow; console.log = origLog; restore(); setCycleHandler(null);
  }
  assert.equal(seen.length, 0, 'no signal from a series with a hole');
  const gapEvent = events.find(p => p[7] === 'DATA_GAP');
  assert.ok(gapEvent, 'DATA_GAP recorded in signal_events');
  assert.equal(gapEvent[1], 'HOLEUSDT');
  assert.equal(gapEvent[5], 'data');
});
