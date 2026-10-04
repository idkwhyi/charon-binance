import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { evaluateExit, settleExit, applySlippage, computeTradePnl } from '../src/execution/simulation.js';
import { runBacktest, lowerBoundByOpenTime, candlesBetween, lastClosedPrice } from '../src/backtest/runner.js';
import { SIM_SLIPPAGE_PERCENT, SIM_TAKER_FEE_PERCENT, RISK_PERCENT_PER_TRADE } from '../src/config.js';
import { installFakePool } from './helpers/fakePool.js';

const M1 = 60_000;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const k = (openTime, step, o = {}) => ({ openTime, open: 100, high: 100.05, low: 99.95, close: 100, volume: 1, quoteVolume: 1e6, closeTime: openTime + step - 1, ...o });

// ── evaluateExit: the shared dry-run/backtest exit evaluation ─────────────────

const pos = { direction: 'LONG', stopLoss: 95, takeProfit: 110, openedAtMs: 0, lastCheckedMs: 0 };

test('evaluateExit: SL/TP from closed 1m candles, with the checkpoint advanced', () => {
  const cs = [k(0, M1), k(M1, M1, { low: 94.5 }), k(2 * M1, M1, { high: 111 })];
  const r = evaluateExit(pos, cs, { nowMs: 10 * M1 });
  assert.equal(r.trigger.exitReason, 'SL');
  assert.equal(r.lastCheckedMs, 2 * M1 - 1);
  const none = evaluateExit(pos, [k(0, M1), k(M1, M1)], { nowMs: 10 * M1 });
  assert.equal(none.trigger, null);
  assert.equal(none.lastCheckedMs, 2 * M1 - 1);
});

const T0 = 100 * M1; // isMaxHoldHit treats openedAtMs <= 0 as invalid
const held = { ...pos, openedAtMs: T0 };

test('evaluateExit: MAX_HOLD when nothing was hit, at the given price', () => {
  const r = evaluateExit(held, [k(T0, M1)], { nowMs: T0 + 5 * M1, maxHoldMs: 3 * M1, maxHoldPrice: 101 });
  assert.deepEqual(r.trigger, { exitReason: 'MAX_HOLD', exitPriceRaw: 101 });
  assert.equal(evaluateExit(held, [k(T0, M1)], { nowMs: T0 + 2 * M1, maxHoldMs: 3 * M1, maxHoldPrice: 101 }).trigger, null);
});

test('evaluateExit: a SL touched after the hold limit does not count — MAX_HOLD came first', () => {
  const cs = [k(T0, M1), k(T0 + M1, M1), k(T0 + 2 * M1, M1), k(T0 + 3 * M1, M1, { low: 90 })];
  const r = evaluateExit(held, cs, { nowMs: T0 + 10 * M1, maxHoldMs: 3 * M1, maxHoldPrice: 100 });
  assert.equal(r.trigger.exitReason, 'MAX_HOLD');
  // without a hold limit the same candle is a SL
  assert.equal(evaluateExit(held, cs, { nowMs: T0 + 10 * M1 }).trigger.exitReason, 'SL');
});

test('settleExit = adverse exit slippage + computeTradePnl', () => {
  const p = { direction: 'SHORT', entryPrice: 100, entryMarkPrice: 100.03, quantity: 2, riskUsdt: 10, marginUsdt: 40 };
  const s = settleExit(p, { exitReason: 'TP', exitPriceRaw: 90 }, { slippagePercent: 0.03, feePercent: 0.05 });
  close(s.exitPrice, 90 * 1.0003);
  const ref = computeTradePnl({ ...p, exitPrice: s.exitPrice, exitPriceRaw: 90, feePercent: 0.05 });
  close(s.pnlUsdt, ref.pnlUsdt);
  close(s.pnlR, ref.pnlR);
});

test('runner candle helpers', () => {
  const cs = [k(0, M1), k(M1, M1), k(2 * M1, M1, { close: 99 })];
  assert.equal(lowerBoundByOpenTime(cs, M1), 1);
  assert.equal(lowerBoundByOpenTime(cs, M1 + 1), 2);
  assert.deepEqual(candlesBetween(cs, M1, 3 * M1).map(c => c.openTime), [M1, 2 * M1]);
  assert.equal(lastClosedPrice(cs, 3 * M1), 99);
  assert.equal(lastClosedPrice(cs, 3 * M1 - 1), 100, 'the candle closing at 3m-1 is not closed before 3m-1');
});

// ── End to end: backtest fills equal the shared simulation's fills ───────────

const D = Date.UTC(2026, 0, 10);       // backtest start (15m aligned)
const SPIKE_15M_OPEN = D + 30 * M1;     // spike candle closes at D+45m-1
const ENTRY_T = D + 45 * M1;            // first tick that sees it
const DROP_1M_OPEN = ENTRY_T + 5 * M1;  // 1m candle that wicks through SL

function candleAt(interval, openTime) {
  const step = { '1m': M1, '15m': 15 * M1, '1h': 60 * M1 }[interval];
  if (interval === '15m' && openTime === SPIKE_15M_OPEN) return k(openTime, step, { open: 99.9, volume: 1000 });
  if (interval === '1m' && openTime === DROP_1M_OPEN) return k(openTime, step, { open: 99.5, high: 99.6, low: 98, close: 98.2 });
  if (interval === '1m' && openTime > DROP_1M_OPEN) return k(openTime, step, { open: 98.2, high: 98.3, low: 98.1, close: 98.2 });
  return k(openTime, step);
}

function stubHistory() {
  const original = axios.get;
  axios.get = async (url, { params = {} } = {}) => {
    if (url.includes('fundingRate')) return { data: [] };
    const step = { '1m': M1, '15m': 15 * M1, '1h': 60 * M1 }[params.interval];
    const first = Math.ceil(params.startTime / step) * step;
    const rows = [];
    for (let o = first; o <= params.endTime && rows.length < params.limit; o += step) {
      const c = candleAt(params.interval, o);
      rows.push([c.openTime, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume), c.closeTime, String(c.quoteVolume)]);
    }
    return { data: rows };
  };
  return () => { axios.get = original; };
}

test('backtest entry/exit are priced by the same simulation as dry-run', async () => {
  const strat = { signal_types: 'volume_spike', min_volume_spike_ratio: 3, leverage: 5, tp_percent: 2, sl_percent: -1.5, max_hold_ms: 4 * 60 * M1, max_open_positions: 3 };
  const opened = [];
  const closed = [];
  installFakePool((text, params) => {
    if (/LIKE 'strategy:%'/.test(text)) return [{ key: 'strategy:bt_test', value: strat }];
    if (/INSERT INTO backtest_runs/.test(text)) return [{ id: 1 }];
    if (/INSERT INTO backtest_positions/.test(text)) { opened.push(params); return [{ id: 7 }]; }
    if (/UPDATE backtest_positions/.test(text)) { closed.push(params); return []; }
    return [];
  });
  const restore = stubHistory();
  const origLog = console.log;
  console.log = () => {};
  try {
    await runBacktest({ strategyId: 'bt_test', symbols: ['BTUSDT'], dateFromMs: D, dateToMs: D + 3 * 60 * M1, startingBalance: 1000 });
  } finally {
    console.log = origLog;
    restore();
  }

  assert.equal(opened.length, 1, 'one entry from the volume spike');
  assert.equal(closed.length, 1);

  // Expected, computed independently with the shared simulation functions
  const entryMark = 100;
  const entryPrice = applySlippage(entryMark, 'LONG', 'entry', SIM_SLIPPAGE_PERCENT);
  const stopLoss = entryPrice * (1 - 0.015);
  const riskUsdt = 1000 * RISK_PERCENT_PER_TRADE / 100;
  const notional = riskUsdt / 0.015;
  const quantity = notional / entryPrice;
  const margin = notional / 5;

  // openBacktestPosition params: [runId, symbol, signalType, direction, leverage, entry_price, entry_usdt, tp, sl, fee, slippage, opened_at, snapshot]
  const [, symbol, , direction, , oEntry, oMargin, , , oFee, oSlip, oOpenedAt] = opened[0];
  assert.equal(symbol, 'BTUSDT');
  assert.equal(direction, 'LONG');
  assert.equal(oOpenedAt, ENTRY_T);
  close(oEntry, entryPrice);
  close(oMargin, margin, 1e-6);
  close(oFee, entryPrice * quantity * SIM_TAKER_FEE_PERCENT / 100, 1e-6);
  close(oSlip, (entryPrice - entryMark) * quantity, 1e-6);

  const expected = settleExit(
    { direction: 'LONG', entryPrice, entryMarkPrice: entryMark, quantity, riskUsdt: quantity * (entryPrice - stopLoss), marginUsdt: margin },
    { exitReason: 'SL', exitPriceRaw: stopLoss },
    { slippagePercent: SIM_SLIPPAGE_PERCENT, feePercent: SIM_TAKER_FEE_PERCENT },
  );
  // closeBacktestPosition params: [exitPrice, exitReason, pnlPercent, pnlUsdt, feeUsdt, closedAtMs, id, slippageUsdt]
  const [cExit, cReason, cPnlPct, cPnl, cFee, cClosedAt] = closed[0];
  assert.equal(cReason, 'SL');
  close(cExit, expected.exitPrice, 1e-9);
  close(cPnl, expected.pnlUsdt, 1e-6);
  close(cPnlPct, expected.pnlPercent, 1e-6);
  close(cFee, expected.exitFeeUsdt, 1e-6);
  assert.equal(cClosedAt, DROP_1M_OPEN + M1 - 1, 'closed on the 1m candle that touched SL');
});
