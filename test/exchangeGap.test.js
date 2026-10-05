import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findGaps, confirmExchangeGaps, classifyGaps, gapKey, latestClosedOpenTime, INTERVAL_MS } from '../src/signals/klineCache.js';
import { scanSignals, setCycleHandler, _klineCacheForTest, _exchangeGapsForTest } from '../src/signals/scanner.js';
import { runBacktest } from '../src/backtest/runner.js';
import * as runner from '../src/backtest/runner.js';
import { KLINE_STRICT_CONTINUITY_CANDLES_15M as N, KLINE_STRICT_CONTINUITY_CANDLES_1H as N1H } from '../src/config.js';
import { installFakePool } from './helpers/fakePool.js';
import { stubHistory, M15, H1, ampleOpenInterest } from './helpers/history.js';

const c = (openTime, step = M15, extra = {}) => ({ openTime, open: 100, high: 100.1, low: 99.9, close: 100, volume: 1, closeTime: openTime + step - 1, quoteVolume: 100, ...extra });
const range = (from, to, step, extra) => { const out = []; for (let t = from; t <= to; t += step) out.push(c(t, step, extra?.(t))); return out; };

// ── Pure rules ────────────────────────────────────────────────────────────────

test('confirmExchangeGaps: only holes the response covers on both sides', () => {
  const ks = range(0, 10 * M15, M15).filter(k => k.openTime !== 4 * M15 && k.openTime !== 5 * M15);
  const [hole] = findGaps(ks, M15);
  assert.deepEqual(confirmExchangeGaps([hole], ks), [hole]);
  // response that starts after the hole, or ends inside it, can't confirm it
  assert.deepEqual(confirmExchangeGaps([hole], ks.filter(k => k.openTime > 5 * M15)), []);
  assert.deepEqual(confirmExchangeGaps([hole], ks.filter(k => k.openTime < 4 * M15)), []);
  // a tail hole (nothing after it) is never exchange-confirmed
  const tail = findGaps(ks, M15, 13 * M15).at(-1);
  assert.deepEqual(confirmExchangeGaps([tail], ks), []);
  assert.deepEqual(confirmExchangeGaps([hole], []), []);
});

test('classifyGaps: strict last-N, then exchange-confirmed, else data gap', () => {
  const now = 100 * M15 + 1;                          // latest closed candle opened at 99*M15
  const strictFrom = latestClosedOpenTime(M15, now) - (N - 1) * M15;
  const old = { afterOpenTime: 9 * M15, fromOpenTime: 10 * M15, toOpenTime: 11 * M15, count: 2 };
  const edgeOut = { afterOpenTime: strictFrom - 3 * M15, fromOpenTime: strictFrom - 2 * M15, toOpenTime: strictFrom - M15, count: 2 };
  const edgeIn = { afterOpenTime: strictFrom - 2 * M15, fromOpenTime: strictFrom - M15, toOpenTime: strictFrom, count: 2 };
  const keys = new Set([gapKey(old), gapKey(edgeOut), gapKey(edgeIn)]);
  const r = classifyGaps([old, edgeOut, edgeIn], { intervalMs: M15, nowMs: now, strictCandles: N, exchangeGapKeys: keys });
  assert.deepEqual(r.exchange, [old, edgeOut]);
  assert.deepEqual(r.strict, [edgeIn], 'exchange-confirmed but inside the last N → still blocks');
  assert.equal(r.ok, false);
  const unconfirmed = classifyGaps([old], { intervalMs: M15, nowMs: now, strictCandles: N });
  assert.deepEqual(unconfirmed.data, [old]);
  assert.equal(unconfirmed.ok, false);
  assert.equal(classifyGaps([old], { intervalMs: M15, nowMs: now, strictCandles: N, exchangeGapKeys: keys }).ok, true);
});

// ── Live scanner ──────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 9, 4, 12, 0, 30);
const last15 = latestClosedOpenTime(M15, NOW);
const last1h = latestClosedOpenTime(H1, NOW);

function stubExchange(truth, { failBackfill = false } = {}) {
  const original = axios.get;
  const backfills = [];
  axios.get = async (url, { params = {} } = {}) => {
    if (url.includes('/klines')) {
      if (params.startTime !== undefined) {
        backfills.push(params);
        if (failBackfill) throw new Error('network down');
      }
      const rows = (truth[params.interval] || [])
        .filter(k => params.startTime === undefined || k.openTime >= params.startTime)
        .slice(params.startTime === undefined ? -params.limit : 0, params.startTime === undefined ? undefined : params.limit);
      return { data: rows.map(k => [k.openTime, String(k.open), String(k.high), String(k.low), String(k.close), String(k.volume), k.closeTime, String(k.quoteVolume)]) };
    }
    if (url.includes('premiumIndex')) return { data: { lastFundingRate: '0', markPrice: '100' } };
    if (url.includes('openInterest')) return { data: { openInterest: '1' } };
    return { data: { lastPrice: '100', quoteVolume: '1' } };
  };
  return { backfills, restore: () => { axios.get = original; } };
}

function installScanDb(events) {
  installFakePool((text, params) => {
    if (/INSERT INTO signal_events/.test(text)) { events.push({ symbol: params[1], stage: params[5], outcome: params[6], code: params[7] }); return []; }
    if (/key = \$1/.test(text) && params[0] === 'active_strategy') return [{ value: 'xg_test' }];
    if (/LIKE 'strategy:%'/.test(text)) return [{ key: 'strategy:xg_test', value: { signal_types: 'volume_spike', min_volume_spike_ratio: 3 } }];
    if (/key = \$1/.test(text) && params[0] === 'strategy:xg_test') return [{ value: { signal_types: 'volume_spike', min_volume_spike_ratio: 3 } }];
    if (/key = \$1/.test(text)) return [{ value: ['XGUSDT'] }];
    return [];
  });
}

async function scan(truth, opts) {
  const events = [];
  installScanDb(events);
  const ex = stubExchange(truth, opts);
  const seen = [];
  setCycleHandler(async s => { seen.push(...s); });
  const log = console.log; console.log = () => {};
  const realNow = Date.now; Date.now = () => NOW;
  try { await scanSignals(); } finally { Date.now = realNow; console.log = log; ex.restore(); setCycleHandler(null); }
  return { seen, events, backfills: ex.backfills };
}

const series15 = (holeAgo) => range(last15 - 59 * M15, last15, M15, t => (t === last15 ? { volume: 1000 } : {}))
  .filter(k => k.openTime !== last15 - holeAgo * M15);
const truth1h = range(last1h - 59 * H1, last1h, H1);

beforeEach(() => { _klineCacheForTest().clear(); _exchangeGapsForTest().clear(); });

test('live: an exchange-side hole older than the last N candles is accepted and logged once', async () => {
  const truth = { '15m': series15(N + 10), '1h': truth1h };
  const first = await scan(truth);
  assert.equal(first.seen.length, 1, 'symbol scanned, signal emitted');
  assert.deepEqual(first.events.filter(e => e.code === 'EXCHANGE_GAP').map(e => [e.stage, e.outcome]), [['data', 'accepted']]);
  assert.ok(!first.events.some(e => e.code === 'DATA_GAP'));

  const second = await scan(truth); // cache kept, known hole kept
  assert.equal(second.seen.length, 1);
  assert.equal(second.events.filter(e => e.code === 'EXCHANGE_GAP').length, 0, 'not logged again');
  assert.equal(second.backfills.length, 0, 'known exchange hole is not refetched');
});

test('live: a hole inside the last N candles blocks even when the exchange confirms it', async () => {
  const { seen, events } = await scan({ '15m': series15(5), '1h': truth1h });
  assert.equal(seen.length, 0);
  assert.ok(events.some(e => e.code === 'DATA_GAP'));
});

test('live: 1H uses its own N — a 1H hole just older than N_1H is accepted, inside N_1H it blocks', async () => {
  const truth15 = { '15m': series15(1000) };
  const ok = await scan({ ...truth15, '1h': truth1h.filter(k => k.openTime !== last1h - (N1H + 1) * H1) });
  assert.equal(ok.seen.length, 1, `1H hole ${N1H + 1} candles back is outside the 1H strict window`);
  assert.ok(ok.events.some(e => e.code === 'EXCHANGE_GAP'));
  _klineCacheForTest().clear(); _exchangeGapsForTest().clear();
  const blocked = await scan({ ...truth15, '1h': truth1h.filter(k => k.openTime !== last1h - (N1H - 1) * H1) });
  assert.equal(blocked.seen.length, 0);
  assert.ok(blocked.events.some(e => e.code === 'DATA_GAP'));
});

test('live: an old hole that cannot be confirmed (backfill failed) is a DATA_GAP', async () => {
  const { seen, events } = await scan({ '15m': series15(N + 10), '1h': truth1h }, { failBackfill: true });
  assert.equal(seen.length, 0);
  assert.ok(events.some(e => e.code === 'DATA_GAP'));
  assert.ok(!events.some(e => e.code === 'EXCHANGE_GAP'));
});

// ── Backtest applies the same rule ────────────────────────────────────────────

const D = Date.UTC(2026, 0, 10);
let seq = 0;
async function backtest(plan, holes) {
  const id = `xg_bt_${++seq}`;
  const strat = { signal_types: 'volume_spike', min_volume_spike_ratio: 3, leverage: 5, tp_percent: 2, sl_percent: -1.5, max_hold_ms: 4 * H1, max_open_positions: 5 };
  const opened = [];
  installFakePool((text, p) => {
    if (/LIKE 'strategy:%'/.test(text)) return [{ key: `strategy:${id}`, value: strat }];
    if (/key = \$1/.test(text) && p[0] === `strategy:${id}`) return [{ value: strat }];
    if (/INSERT INTO backtest_runs/.test(text)) return [{ id: 1 }];
    if (/INSERT INTO backtest_positions/.test(text)) { opened.push(p[1]); return [{ id: opened.length }]; }
    return [];
  });
  const restore = stubHistory(plan, { holes });
  const log = console.log; console.log = () => {};
  try {
    await runBacktest({ openInterestSource: ampleOpenInterest(), strategyId: id, symbols: Object.keys(plan), dateFromMs: D, dateToMs: D + 6 * H1, startingBalance: 1000,
      cacheDir: mkdtempSync(join(tmpdir(), 'charon-bt-')) });
  } finally { console.log = log; restore(); }
  return { opened, outcomes: runner.lastRunRejections };
}

test('backtest: an old exchange hole is accepted (logged once); a recent one blocks — same as live', async () => {
  const spikeAt = D + 2 * H1;                       // entry tick D+2h15m
  const oldHole = spikeAt - (N + 10) * M15;
  const ok = await backtest({ AAA: [{ spikeAt }] }, { '15m': [oldHole] });
  assert.deepEqual(ok.opened, ['AAA']);
  assert.equal(ok.outcomes.filter(o => o.reasonCode === 'EXCHANGE_GAP' && o.outcome === 'accepted').length, 1);

  const recentHole = spikeAt - 3 * M15;
  const blocked = await backtest({ AAA: [{ spikeAt }] }, { '15m': [recentHole] });
  assert.deepEqual(blocked.opened, []);
  assert.ok(blocked.outcomes.some(o => o.reasonCode === 'DATA_GAP'));
});
