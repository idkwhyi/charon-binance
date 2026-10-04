import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planEntry } from '../src/pipeline/entryPlan.js';

const base = { availableBalanceUsdt: 1000, riskPercent: 1, leverage: 5, maxMarginPercent: 50 };

test('recomputes R:R and SL distance from the actual entry, not OB mid', () => {
  // OB mid 100 would give R:R (110-100)/(100-95)=2.0; actual price 101 gives 9/6=1.5
  const plan = planEntry({ ...base, direction: 'LONG', entryPrice: 101, stopLoss: 95, takeProfit: 110 });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /R:R at actual entry 1\.50 < 1\.8/);
});

test('accepts when R:R and SL distance hold at the actual entry', () => {
  const plan = planEntry({ ...base, direction: 'LONG', entryPrice: 100, stopLoss: 95, takeProfit: 110 });
  assert.equal(plan.ok, true);
  assert.equal(plan.rrRatio, 2);
  assert.equal(plan.slDistancePct, 5);
  assert.equal(plan.entryPrice, 100);
});

test('sizing uses the SL distance at the actual entry', () => {
  const plan = planEntry({ ...base, direction: 'LONG', entryPrice: 100, stopLoss: 95, takeProfit: 110 });
  // risk 1% of 1000 = 10 USDT; SL 5% → notional 200; margin 200/5 = 40
  assert.equal(plan.riskUsdt, 10);
  assert.equal(plan.notionalUsdt, 200);
  assert.equal(plan.entryUsdt, 40);
});

test('rejects SL distance below 0.5%', () => {
  const plan = planEntry({ ...base, direction: 'LONG', entryPrice: 100, stopLoss: 99.6, takeProfit: 101 });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /SL distance .* < 0\.5%/);
});

test('rejects when price already moved beyond SL or TP', () => {
  assert.match(planEntry({ ...base, direction: 'LONG', entryPrice: 94, stopLoss: 95, takeProfit: 110 }).reason, /beyond SL/);
  assert.match(planEntry({ ...base, direction: 'SHORT', entryPrice: 89, stopLoss: 105, takeProfit: 90 }).reason, /beyond TP/);
});

test('SHORT mirrors LONG', () => {
  const plan = planEntry({ ...base, direction: 'SHORT', entryPrice: 100, stopLoss: 105, takeProfit: 90 });
  assert.equal(plan.ok, true);
  assert.equal(plan.rrRatio, 2);
  assert.equal(plan.slPercent, -5);
  assert.equal(plan.tpPercent, 10);
});

test('non-structural signals derive SL/TP from percents and skip the R:R floor', () => {
  const plan = planEntry({ ...base, direction: 'LONG', entryPrice: 100, fallbackTpPercent: 2, fallbackSlPercent: -1.5 });
  assert.equal(plan.ok, true);
  assert.ok(Math.abs(plan.stopLoss - 98.5) < 1e-9);
  assert.ok(Math.abs(plan.takeProfit - 102) < 1e-9);
});

test('rejects a missing entry price', () => {
  assert.equal(planEntry({ ...base, direction: 'LONG', entryPrice: 0, stopLoss: 95, takeProfit: 110 }).ok, false);
});
