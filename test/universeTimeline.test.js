import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeUniverseTimeline, UniverseTimeline } from '../src/backtest/universeTimeline.js';
import { UNIVERSE_RULES, ticker24hFromKlines15m } from '../src/universe/rules.js';
import { runBacktest } from '../src/backtest/runner.js';
import * as runner from '../src/backtest/runner.js';
import { installFakePool } from './helpers/fakePool.js';
import { stubHistory, M1, H1 } from './helpers/history.js';

const M15 = 15 * 60_000, DAY = 86_400_000;
const T0 = Date.UTC(2025, 5, 2); // first tick

/**
 * 15m candles from T0 - 2 days. price(openTime) gives the candle's close; open = previous close.
 * Volume 1M quote per candle (96M per 24h) unless vol(openTime) says otherwise.
 */
function series(price, { from = T0 - 2 * DAY, to = T0 + 3 * DAY, vol = () => 1e6 } = {}) {
  const out = [];
  let prev = price(from - M15);
  for (let o = from; o < to; o += M15) {
    const c = price(o);
    out.push({ openTime: o, open: prev, high: Math.max(prev, c), low: Math.min(prev, c), close: c, volume: 1, closeTime: o + M15 - 1, quoteVolume: vol(o) });
    prev = c;
  }
  return out;
}
const flat = () => 100;
// +10% step on the candle opening at `at`: visible from the close at at + 15m, gone 24h later
const jump = at => o => (o >= at ? 110 : 100);

function loaderFor(map) {
  const calls = [];
  const load15m = async (symbol, fromMs, toMs) => {
    calls.push([symbol, fromMs, toMs]);
    return (map[symbol] || []).filter(k => k.openTime >= fromMs && k.openTime <= toMs);
  };
  return { load15m, calls };
}
const cand = (symbol, underlyingType = 'COIN') => ({ symbol, firstDayMs: T0 - 3 * DAY, lastDayMs: T0 + 5 * DAY, underlyingType });

test('enters at the first 15m close whose trailing 24h shows the move, exits 24h later (no lookahead)', async () => {
  const at = T0 + 4 * M15;
  const { load15m } = loaderFor({ AUSDT: series(jump(at)), BUSDT: series(flat) });
  const tl = await computeUniverseTimeline({
    candidates: [cand('AUSDT'), cand('BUSDT')], dateFromMs: T0, dateToMs: T0 + 2 * DAY, load15m,
  });
  // the jump candle closes at at + 15m - 1, so the close at at + 15m is the first to see it
  assert.deepEqual(tl.intervals.get('AUSDT'), [[at + M15, at + M15 + DAY]]);
  assert.ok(!tl.isMember('AUSDT', at), 'the candle that is still forming at t is not used');
  assert.ok(tl.isMember('AUSDT', at + M15));
  assert.ok(!tl.isMember('AUSDT', at + M15 + DAY), 'the move left the 24h window');
  assert.equal(tl.intervals.has('BUSDT'), false, 'flat: |change| < 2%');
  assert.deepEqual(tl.events, [{ t: at + M15, symbol: 'AUSDT', type: 'enter' }, { t: at + M15 + DAY, symbol: 'AUSDT', type: 'exit' }]);
});

test('24h stats come from the 96 last closed 15m candles via rules.ticker24hFromKlines15m', async () => {
  // volume: 0.4M/candle → 38.4M/24h (< 50M) until a burst, so membership is decided by the 24h sum
  const at = T0 + 8 * M15;
  const ks = series(jump(T0 - DAY), { vol: o => (o >= at && o < at + 4 * M15 ? 4e6 : 0.4e6) });
  const { load15m } = loaderFor({ VUSDT: ks });
  const tl = await computeUniverseTimeline({ candidates: [cand('VUSDT')], dateFromMs: T0, dateToMs: T0 + DAY, load15m,
    rules: { ...UNIVERSE_RULES, minAbsChangePercent: 0 } });
  const [enter] = tl.intervals.get('VUSDT')[0];
  const window = ks.filter(k => k.openTime >= enter - DAY && k.closeTime < enter);
  assert.equal(window.length, 96);
  assert.ok(ticker24hFromKlines15m(window).quoteVolume >= 50e6);
  const before = ks.filter(k => k.openTime >= enter - M15 - DAY && k.closeTime < enter - M15);
  assert.ok(ticker24hFromKlines15m(before).quoteVolume < 50e6, 'one close earlier it did not qualify');
});

test('top N by |change|: a symbol leaves when pushed out of the top N, core symbols never leave', async () => {
  const rules = { ...UNIVERSE_RULES, topN: 1 };
  const { load15m } = loaderFor({
    AUSDT: series(o => (o >= T0 ? 105 : 100)),         // +5%
    BUSDT: series(o => (o >= T0 + 8 * M15 ? 92 : 100)), // -8% later: takes the single slot
    CORE1USDT: series(flat),
  });
  const tl = await computeUniverseTimeline({
    candidates: [cand('AUSDT'), cand('BUSDT'), cand('CORE1USDT')], dateFromMs: T0, dateToMs: T0 + 12 * M15, load15m,
    core: ['CORE1USDT'], rules,
  });
  assert.deepEqual(tl.intervals.get('AUSDT'), [[T0 + M15, T0 + 9 * M15]]);
  assert.deepEqual(tl.intervals.get('BUSDT'), [[T0 + 9 * M15, null]]);
  assert.deepEqual(tl.intervals.get('CORE1USDT'), [[T0, null]]);
  assert.equal(tl.totalMs('BUSDT'), T0 + 13 * M15 - (T0 + 9 * M15));
});

test('unknown underlyingType (not in exchangeInfo): rejected by default and reported, or treated as COIN', async () => {
  const map = { GONEUSDT: series(o => (o >= T0 ? 110 : 100)), EQUSDT: series(o => (o >= T0 ? 110 : 100)) };
  const candidates = [cand('GONEUSDT', null), cand('EQUSDT', 'EQUITY')];
  const strict = await computeUniverseTimeline({ candidates, dateFromMs: T0, dateToMs: T0 + 4 * M15, load15m: loaderFor(map).load15m });
  assert.equal(strict.intervals.size, 0);
  assert.deepEqual(strict.excludedUnknownType, ['GONEUSDT']);
  const loose = await computeUniverseTimeline({ candidates, dateFromMs: T0, dateToMs: T0 + 4 * M15, load15m: loaderFor(map).load15m, unknownUnderlying: 'coin' });
  assert.deepEqual([...loose.intervals.keys()], ['GONEUSDT'], 'EQUITY stays out either way');
});

test('only symbols trading around the chunk are loaded; stablecoins and non-USDT never', async () => {
  const { load15m, calls } = loaderFor({});
  await computeUniverseTimeline({
    candidates: [cand('AUSDT'), { ...cand('OLDUSDT'), lastDayMs: T0 - 3 * DAY }, cand('USDCUSDT'), cand('BTCUSDC')],
    dateFromMs: T0, dateToMs: T0 + DAY, load15m,
  });
  assert.deepEqual([...new Set(calls.map(c => c[0]))], ['AUSDT']);
});

test('UniverseTimeline.fixed: every symbol for the whole run; JSON summary', () => {
  const tl = UniverseTimeline.fixed(['AUSDT', 'BUSDT'], T0, T0 + DAY);
  assert.ok(tl.isMember('AUSDT', T0) && tl.isMember('BUSDT', T0 + DAY));
  const j = tl.toJSON();
  assert.equal(j.mode, 'fixed');
  assert.deepEqual(j.members.map(m => [m.symbol, m.totalMs]), [['AUSDT', DAY + M15], ['BUSDT', DAY + M15]]);
});

test('runner: signals only for symbols in the universe at that 15m close', async () => {
  const D = Date.UTC(2026, 0, 10);
  const id = 'universe_gate_test';
  const strat = { signal_types: 'volume_spike', min_volume_spike_ratio: 3, leverage: 5, tp_percent: 2, sl_percent: -1.5, max_hold_ms: 4 * H1, max_open_positions: 5 };
  const opened = [];
  let params = null;
  installFakePool((text, p) => {
    if (/LIKE 'strategy:%'/.test(text)) return [{ key: `strategy:${id}`, value: strat }];
    if (/key = \$1/.test(text) && p[0] === `strategy:${id}`) return [{ value: strat }];
    if (/INSERT INTO backtest_runs/.test(text)) return [{ id: 1 }];
    if (/INSERT INTO backtest_positions/.test(text)) { opened.push({ symbol: p[1], openedAt: p[11] }); return [{ id: opened.length }]; }
    if (/SET params_json/.test(text)) params = JSON.parse(p[0]);
    return [];
  });
  // Both spike at D+30m (signal at the D+45m close); AAA only joins the universe at D+1h
  const universe = new UniverseTimeline({
    intervals: new Map([['AAA', [[D + H1, null]]], ['BBB', [[D, null]]]]),
    events: [], core: ['BBB'], dateFromMs: D, dateToMs: D + 8 * H1,
  });
  const restore = stubHistory({ AAA: [{ spikeAt: D + 30 * M1 }, { spikeAt: D + 3 * H1 }], BBB: [{ spikeAt: D + 30 * M1 }] });
  const log = console.log; console.log = () => {};
  try {
    await runBacktest({ strategyId: id, universe, dateFromMs: D, dateToMs: D + 8 * H1, startingBalance: 1000,
      cacheDir: mkdtempSync(join(tmpdir(), 'charon-bt-')) });
  } finally { console.log = log; restore(); }
  assert.deepEqual(opened.map(o => [o.symbol, o.openedAt]), [['BBB', D + 45 * M1], ['AAA', D + 3 * H1 + 15 * M1]]);
  assert.ok(!runner.lastRunRejections.some(r => r.symbol === 'AAA' && r.stage === 'pipeline'), 'AAA not evaluated before it joined');
  assert.deepEqual(params.universe.members.map(m => m.symbol), ['AAA', 'BBB']);
});
