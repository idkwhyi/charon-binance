import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utcDayStartMs, dailyLossStatus, directionCounts, directionCapReached } from '../src/pipeline/riskControls.js';
import { planEntry } from '../src/pipeline/entryPlan.js';
import { estimateLiqPrice } from '../src/execution/positionMath.js';
import { selectCandidate } from '../src/pipeline/candidateSelector.js';
import { installFakePool } from './helpers/fakePool.js';
import { boolSetting, getSetting, setActiveSetting } from '../src/db/settings.js';
import { realizedPnlSince } from '../src/db/positions.js';

test('UTC day starts at 00:00 UTC (07:00 WIB)', () => {
  const t = Date.UTC(2026, 9, 4, 23, 59); // 06:59 WIB next day
  assert.equal(utcDayStartMs(t), Date.UTC(2026, 9, 4));
  assert.equal(utcDayStartMs(Date.UTC(2026, 9, 5, 0, 0)), Date.UTC(2026, 9, 5));
});

test('daily loss limit is -3% of start-of-day balance', () => {
  // started the day at 1000, realized -29 → -2.9%: still OK
  assert.equal(dailyLossStatus({ currentBalanceUsdt: 971, realizedTodayUsdt: -29, limitPercent: 3 }).breached, false);
  // realized -30 → exactly -3%: blocked
  const s = dailyLossStatus({ currentBalanceUsdt: 970, realizedTodayUsdt: -30, limitPercent: 3 });
  assert.equal(s.breached, true);
  assert.equal(s.startOfDayBalanceUsdt, 1000);
  assert.ok(Math.abs(s.pnlPercent + 3) < 1e-9);
  // profitable day never blocks
  assert.equal(dailyLossStatus({ currentBalanceUsdt: 1050, realizedTodayUsdt: 50, limitPercent: 3 }).breached, false);
});

test('max 2 open positions in the same direction', () => {
  const open = [{ direction: 'LONG' }, { direction: 'LONG' }, { direction: 'SHORT' }];
  assert.deepEqual(directionCounts(open), { LONG: 2, SHORT: 1 });
  assert.equal(directionCapReached(open, 'LONG', 2), true);
  assert.equal(directionCapReached(open, 'SHORT', 2), false);
});

test('selector skips directions at their cap', () => {
  const c = (symbol, direction, score) => ({ symbol, direction, signals: { meta: { entryConfirmation: { score } } }, metrics: {} });
  const picked = selectCandidate([c('AAA', 'LONG', 9), c('BBB', 'SHORT', 6)], new Set(), ['LONG']);
  assert.equal(picked.symbol, 'BBB');
});

test('liquidation estimate matches the executor formula', () => {
  assert.ok(Math.abs(estimateLiqPrice(100, 'LONG', 10) - 91) < 1e-9);
  assert.ok(Math.abs(estimateLiqPrice(100, 'SHORT', 10) - 109) < 1e-9);
});

test('entry is cancelled when SL is not closer than the liquidation estimate', () => {
  const base = { availableBalanceUsdt: 1000, riskPercent: 1, maxMarginPercent: 50 };
  // 20x LONG: liq ~95.5; SL 95 sits beyond it
  const bad = planEntry({ ...base, leverage: 20, direction: 'LONG', entryPrice: 100, stopLoss: 95, takeProfit: 110 });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /liquidation/);
  // 5x LONG: liq 82; SL 95 is fine
  const ok = planEntry({ ...base, leverage: 5, direction: 'LONG', entryPrice: 100, stopLoss: 95, takeProfit: 110 });
  assert.equal(ok.ok, true);
  assert.ok(Math.abs(ok.liqPrice - 82) < 1e-9);
  // SHORT mirror at 20x: liq ~104.5; SL 105 beyond it
  assert.equal(planEntry({ ...base, leverage: 20, direction: 'SHORT', entryPrice: 100, stopLoss: 105, takeProfit: 90 }).ok, false);
});

test('settings round-trip through JSONB: pause flag can be set and cleared', async () => {
  const store = new Map();
  installFakePool((text, params) => {
    if (/^\s*INSERT INTO strategy_config/.test(text)) { store.set(params[0], JSON.parse(params[1])); return []; }
    if (/SELECT value FROM strategy_config WHERE key = \$1/.test(text)) {
      return store.has(params[0]) ? [{ value: store.get(params[0]) }] : [];
    }
    return [];
  });
  assert.equal(await boolSetting('entries_paused', false), false);
  await setActiveSetting('entries_paused', true);
  assert.equal(await boolSetting('entries_paused', false), true);
  await setActiveSetting('entries_paused', false);
  assert.equal(await boolSetting('entries_paused', true), false, 'stored false must not fall back to the default');
  await setActiveSetting('active_strategy', 'extreme_ob');
  assert.equal(await getSetting('active_strategy'), 'extreme_ob');
});

test('realizedPnlSince sums closed PnL for the mode since a timestamp', async () => {
  const calls = installFakePool(() => [{ pnl: '-12.5' }]);
  assert.equal(await realizedPnlSince(123, 'dry_run'), -12.5);
  assert.deepEqual(calls[0].params, [123, 'dry_run']);
  assert.match(calls[0].text, /status = 'closed'/);
});
