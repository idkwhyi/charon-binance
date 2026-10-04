import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionSize, exitQuantity } from '../src/execution/positionMath.js';
import { installFakePool } from './helpers/fakePool.js';
import { createDryRunPosition } from '../src/db/positions.js';

test('notional is margin x leverage; quantity is notional / entry price', () => {
  const { notionalUsdt, quantity } = positionSize({ entryUsdt: 20, leverage: 5, entryPrice: 50 });
  assert.equal(notionalUsdt, 100);
  assert.equal(quantity, 2);
});

test('exit quantity equals the stored entry quantity', () => {
  assert.equal(exitQuantity({ quantity: '0.123', entry_usdt: '999', leverage: 50, entry_price: '1' }), 0.123);
});

test('legacy rows (no quantity) rebuild quantity from margin x leverage, not notional_usdt', () => {
  // legacy bug: notional_usdt held the margin (20). Correct quantity = 20*5/50 = 2, not 20/50 = 0.4
  const legacy = { quantity: null, entry_usdt: '20', notional_usdt: '20', leverage: 5, entry_price: '50' };
  assert.equal(exitQuantity(legacy), 2);
});

const VB_ROW = {
  id: 1, balance_usdt: '1000', available_balance: '1000', margin_used: '0', unrealized_pnl: '0',
  total_realized_pnl: '0', max_drawdown_percent: '0', peak_balance: '1000', starting_balance: '1000',
};

test('createDryRunPosition stores notional = margin x leverage and quantity', async () => {
  const calls = installFakePool((text) => {
    if (/FROM virtual_balance/.test(text)) return [VB_ROW];
    if (/INSERT INTO positions/.test(text)) return [{ id: 42 }];
    return [];
  });
  const candidate = {
    symbol: 'BTCUSDT', leverage: 5, marginType: 'ISOLATED', entryUsdt: 20, strategyId: 'extreme_ob',
    metrics: { markPrice: 50 }, signals: { meta: { stopLoss: 48, takeProfit: 56 } },
  };
  const id = await createDryRunPosition(7, candidate, { direction: 'LONG' });
  assert.equal(id, 42);

  const insert = calls.find(c => /INSERT INTO positions/.test(c.text));
  const cols = insert.text.match(/INSERT INTO positions \(([^)]*)\)/)[1].split(',').map(c => c.trim());
  const row = Object.fromEntries(cols.slice(0, insert.params.length).map((c, i) => [c, insert.params[i]]));
  assert.equal(row.entry_usdt, 20);
  assert.equal(row.notional_usdt, 100);
  assert.equal(row.quantity, 2);
  assert.equal(row.entry_price, 50);
});
