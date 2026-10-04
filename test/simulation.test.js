import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySlippage, findCandleExit, eligibleCandles, computeTradePnl, levelsFromPercents } from '../src/execution/simulation.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const candle = (openTime, open, high, low) => ({ openTime, open, high, low, close: open, closeTime: openTime + 59_999 });

test('slippage is always adverse', () => {
  close(applySlippage(100, 'LONG', 'entry', 0.03), 100.03);
  close(applySlippage(100, 'LONG', 'exit', 0.03), 99.97);
  close(applySlippage(100, 'SHORT', 'entry', 0.03), 99.97);
  close(applySlippage(100, 'SHORT', 'exit', 0.03), 100.03);
});

const long = { direction: 'LONG', stopLoss: 95, takeProfit: 110 };
const short = { direction: 'SHORT', stopLoss: 105, takeProfit: 90 };

test('SL wins when SL and TP are touched in the same 1m candle', () => {
  assert.equal(findCandleExit(long, [candle(0, 100, 111, 94)]).exitReason, 'SL');
  assert.equal(findCandleExit(short, [candle(0, 100, 106, 89)]).exitReason, 'SL');
});

test('detects TP/SL from candle wicks, first candle wins', () => {
  const hit = findCandleExit(long, [candle(0, 100, 104, 97), candle(60_000, 104, 110.5, 103), candle(120_000, 100, 100, 90)]);
  assert.equal(hit.exitReason, 'TP');
  assert.equal(hit.exitPriceRaw, 110);
  assert.equal(hit.candle.openTime, 60_000);
  assert.equal(findCandleExit(long, [candle(0, 100, 104, 97)]), null);
});

test('SL fills at the open when price gaps through it', () => {
  assert.equal(findCandleExit(long, [candle(0, 93, 94, 92)]).exitPriceRaw, 93);
  assert.equal(findCandleExit(long, [candle(0, 96, 97, 94)]).exitPriceRaw, 95);
  assert.equal(findCandleExit(short, [candle(0, 107, 108, 106)]).exitPriceRaw, 107);
});

test('TP never fills better than the TP level', () => {
  assert.equal(findCandleExit(long, [candle(0, 112, 113, 111)]).exitPriceRaw, 110);
});

test('liquidation guard takes priority', () => {
  const hit = findCandleExit({ ...long, liqPrice: 90 }, [candle(0, 100, 100, 89)]);
  assert.equal(hit.exitReason, 'LIQ_GUARD');
  assert.equal(hit.exitPriceRaw, 90);
});

test('only fully closed candles after open / last check are eligible', () => {
  const cs = [candle(0, 1, 1, 1), candle(60_000, 1, 1, 1), candle(120_000, 1, 1, 1)];
  assert.deepEqual(eligibleCandles(cs, { openedAtMs: 30_000, nowMs: 200_000 }).map(c => c.openTime), [60_000, 120_000]);
  assert.deepEqual(eligibleCandles(cs, { openedAtMs: 0, lastCheckedMs: 119_999, nowMs: 200_000 }).map(c => c.openTime), [120_000]);
  // still forming candle (closeTime >= now) is excluded
  assert.deepEqual(eligibleCandles(cs, { openedAtMs: 0, nowMs: 150_000 }).map(c => c.openTime), [0, 60_000]);
});

test('PnL nets taker fee on both sides and reports R and slippage', () => {
  // LONG 1 unit: mark 100 → filled 100.03; SL raw 95 → filled 94.9715
  const p = computeTradePnl({
    direction: 'LONG', quantity: 1, feePercent: 0.05, riskUsdt: 5.03, marginUsdt: 20,
    entryMarkPrice: 100, entryPrice: 100.03, exitPriceRaw: 95, exitPrice: 94.9715,
  });
  close(p.grossPnlUsdt, 94.9715 - 100.03);
  close(p.entryFeeUsdt, 100.03 * 0.0005);
  close(p.exitFeeUsdt, 94.9715 * 0.0005);
  close(p.pnlUsdt, p.grossPnlUsdt - p.feeUsdt);
  close(p.slippageUsdt, 0.03 + 0.0285);
  close(p.pnlR, p.pnlUsdt / 5.03);
  assert.ok(p.pnlR < -1, 'a stopped-out trade loses more than 1R after costs');
  close(p.pnlPercent, p.pnlUsdt / 20 * 100);
});

test('SHORT PnL sign', () => {
  const p = computeTradePnl({ direction: 'SHORT', quantity: 2, feePercent: 0, riskUsdt: 10, marginUsdt: 40,
    entryMarkPrice: 100, entryPrice: 100, exitPriceRaw: 90, exitPrice: 90 });
  close(p.pnlUsdt, 20);
  close(p.pnlR, 2);
});

test('levelsFromPercents inverts the stored raw-% convention', () => {
  const l = levelsFromPercents('LONG', 100, 10, -5);
  close(l.stopLoss, 95); close(l.takeProfit, 110);
  const s = levelsFromPercents('SHORT', 100, 10, -5);
  close(s.stopLoss, 105); close(s.takeProfit, 90);
});
