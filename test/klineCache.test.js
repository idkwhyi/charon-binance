import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { closedOnly, mergeCandle, parseClosedKlineMessage } from '../src/signals/klineCache.js';
import { fetchKlines } from '../src/enrichment/binance.js';
import { scanSignals, setCycleHandler, applyClosedKline, _klineCacheForTest } from '../src/signals/scanner.js';
import { installFakePool } from './helpers/fakePool.js';

const M15 = 15 * 60_000;
const H1 = 60 * 60_000;
const c = (openTime, step, extra = {}) => ({ openTime, open: 100, high: 100.1, low: 99.9, close: 100, volume: 1, closeTime: openTime + step - 1, quoteVolume: 100, ...extra });

test('closedOnly drops the forming candle (closeTime >= now)', () => {
  const now = 10 * M15 + 5;
  const ks = [c(8 * M15, M15), c(9 * M15, M15), c(10 * M15, M15)];
  assert.deepEqual(closedOnly(ks, now).map(k => k.openTime), [8 * M15, 9 * M15]);
  // exactly at closeTime it is still forming; one ms later it is closed
  assert.equal(closedOnly([c(0, M15)], M15 - 1).length, 0);
  assert.equal(closedOnly([c(0, M15)], M15).length, 1);
});

test('mergeCandle replaces by openTime instead of appending a duplicate', () => {
  const forming = c(2 * M15, M15, { close: 101, volume: 5 });
  const closed = c(2 * M15, M15, { close: 102, volume: 9 });
  const merged = mergeCandle([c(0, M15), c(M15, M15), forming], closed);
  assert.equal(merged.length, 3);
  assert.equal(merged[2].close, 102);
  assert.equal(merged.filter(k => k.openTime === 2 * M15).length, 1);
});

test('mergeCandle keeps order and caps length', () => {
  const merged = mergeCandle([c(M15, M15), c(3 * M15, M15)], c(2 * M15, M15), 2);
  assert.deepEqual(merged.map(k => k.openTime), [2 * M15, 3 * M15]);
});

const wsMsg = (x) => JSON.stringify({ data: { e: 'kline', k: { s: 'BTCUSDT', i: '15m', t: 0, T: M15 - 1, o: '1', h: '2', l: '0.5', c: '1.5', v: '10', q: '15', x } } });

test('WebSocket parser ignores candles that are still forming', () => {
  assert.equal(parseClosedKlineMessage(wsMsg(false)), null);
  const parsed = parseClosedKlineMessage(wsMsg(true));
  assert.equal(parsed.symbol, 'BTCUSDT');
  assert.equal(parsed.interval, '15m');
  assert.equal(parsed.candle.close, 1.5);
  assert.equal(parseClosedKlineMessage('not json'), null);
  assert.equal(parseClosedKlineMessage(JSON.stringify({ data: { e: 'markPrice' } })), null);
});

// ── REST + scanner, with axios and the DB stubbed ─────────────────────────────

const toRaw = k => [k.openTime, String(k.open), String(k.high), String(k.low), String(k.close), String(k.volume), k.closeTime, String(k.quoteVolume)];

function series(step, count, nowMs, { lastClosedVolume = 1, formingVolume = 1 } = {}) {
  const formingOpen = Math.floor(nowMs / step) * step;
  const closed = Array.from({ length: count }, (_, i) => c(formingOpen - (count - i) * step, step));
  closed[closed.length - 1].volume = lastClosedVolume;
  return [...closed, c(formingOpen, step, { volume: formingVolume })];
}

function stubBinance(nowMs, volumes) {
  const original = axios.get;
  axios.get = async (url, { params = {} } = {}) => {
    if (url.includes('/klines')) {
      const step = params.interval === '1h' ? H1 : M15;
      return { data: series(step, 60, nowMs, params.interval === '15m' ? volumes : {}).map(toRaw) };
    }
    if (url.includes('premiumIndex')) return { data: { lastFundingRate: '0', markPrice: '100' } };
    if (url.includes('openInterest')) return { data: { openInterest: '1' } };
    return { data: { lastPrice: '100', quoteVolume: '1' } };
  };
  return () => { axios.get = original; };
}

test('fetchKlines never returns the forming candle', async () => {
  const restore = stubBinance(Date.now(), {});
  try {
    const ks = await fetchKlines('BTCUSDT', '15m', 100);
    const now = Date.now();
    assert.equal(ks.length, 60);
    assert.ok(ks.every(k => k.closeTime < now));
  } finally {
    restore();
  }
});

function installScannerDb() {
  installFakePool((text, params) => {
    if (/key = \$1/.test(text) && params[0] === 'active_strategy') return [{ value: 'cc_test' }];
    if (/LIKE 'strategy:%'/.test(text)) {
      return [{ key: 'strategy:cc_test', value: { signal_types: 'volume_spike', min_volume_spike_ratio: 3 } }];
    }
    if (/key = \$1/.test(text) && params[0] === 'strategy:cc_test') {
      return [{ value: { signal_types: 'volume_spike', min_volume_spike_ratio: 3 } }];
    }
    if (/key = \$1/.test(text)) return [{ value: '["CCTUSDT"]' }]; // watchlist
    return [];
  });
}

async function scanWith(volumes) {
  installScannerDb();
  _klineCacheForTest().clear();
  const restore = stubBinance(Date.now(), volumes);
  const seen = [];
  setCycleHandler(async signals => { seen.push(...signals); });
  const origLog = console.log;
  console.log = () => {};
  try {
    await scanSignals();
  } finally {
    console.log = origLog;
    restore();
    setCycleHandler(null);
  }
  return seen;
}

test('a spike that exists only on the forming candle never produces a signal', async () => {
  const seen = await scanWith({ formingVolume: 1000 });
  assert.equal(seen.length, 0);
});

test('positive control: the same spike on the last closed candle does, and no forming candle is attached', async () => {
  const seen = await scanWith({ lastClosedVolume: 1000 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].signalType, 'volume_spike');
  const now = Date.now();
  assert.ok(seen[0].klines15m.every(k => k.closeTime < now));
  assert.ok(seen[0].klines1h.every(k => k.closeTime < now));
});

test('a closed WebSocket candle replaces the cached copy with the same openTime', () => {
  const cache = _klineCacheForTest();
  cache.clear();
  cache.set('XYZUSDT', { '1h': [], '15m': [c(0, M15), c(M15, M15, { close: 1 })] });
  applyClosedKline({ symbol: 'XYZUSDT', interval: '15m', candle: c(M15, M15, { close: 2 }) });
  applyClosedKline({ symbol: 'XYZUSDT', interval: '15m', candle: c(2 * M15, M15, { close: 3 }) });
  const ks = cache.get('XYZUSDT')['15m'];
  assert.deepEqual(ks.map(k => [k.openTime, k.close]), [[0, 100], [M15, 2], [2 * M15, 3]]);
});
