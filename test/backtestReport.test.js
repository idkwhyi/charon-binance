import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeTrades, aggregateOutcomes, summarizeOutcomes, buildBacktestReport, formatBacktestReport } from '../src/backtest/report.js';
import { runBacktest } from '../src/backtest/runner.js';
import { installFakePool } from './helpers/fakePool.js';
import { stubHistory, M15, H1 } from './helpers/history.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const pos = (o) => ({ symbol: 'AAA', direction: 'LONG', exit_reason: 'TP', fee_usdt: '0.1', slippage_usdt: '0.05', ...o });

test('summarizeTrades: win rate, expectancy in R, profit factor, drawdown, exits', () => {
  const s = summarizeTrades([
    pos({ closed_at_ms: '1', pnl_usdt: '20', pnl_r: '2' }),
    pos({ closed_at_ms: '2', pnl_usdt: '-10', pnl_r: '-1.05', exit_reason: 'SL' }),
    pos({ closed_at_ms: '3', pnl_usdt: '-10', pnl_r: '-1.05', exit_reason: 'SL' }),
    pos({ closed_at_ms: '4', pnl_usdt: '5', pnl_r: '0.5', exit_reason: 'MAX_HOLD' }),
  ], { days: 2, startingBalance: 1000 });
  assert.equal(s.trades, 4);
  assert.equal(s.tradesPerDay, 2);
  assert.equal(s.winRate, 50);
  close(s.expectancyR, (2 - 1.05 - 1.05 + 0.5) / 4);
  close(s.profitFactor, 25 / 20);
  close(s.maxDrawdownUsdt, 20);                // peak 1020 -> 1000
  close(s.maxDrawdownPercent, 20 / 1020 * 100);
  assert.deepEqual(s.exits, { SL: 2, TP: 1, MAX_HOLD: 1, LIQ_GUARD: 0 });
  close(s.fees, 0.4);
});

test('summarizeTrades handles no trades and missing R', () => {
  const empty = summarizeTrades([], { days: 1, startingBalance: 1000 });
  assert.equal(empty.trades, 0);
  assert.equal(empty.expectancyR, null);
  assert.equal(empty.profitFactor, 0);
  const noR = summarizeTrades([pos({ closed_at_ms: '1', pnl_usdt: '3', pnl_r: null })], { days: 1, startingBalance: 1000 });
  assert.equal(noR.tradesWithR, 0);
  assert.equal(noR.profitFactor, Infinity);
});

test('outcomes are aggregated and split by symbol and direction', () => {
  const rows = aggregateOutcomes([
    { symbol: 'AAA', direction: 'LONG', stage: 'pipeline', outcome: 'rejected', reasonCode: 'not_selected' },
    { symbol: 'AAA', direction: 'LONG', stage: 'pipeline', outcome: 'rejected', reasonCode: 'not_selected' },
    { symbol: 'BBB', direction: 'SHORT', stage: 'detector', outcome: 'rejected', reasonCode: 'funding_filter' },
    { symbol: 'BBB', direction: 'SHORT', stage: 'detector', outcome: 'watch', reasonCode: 'not_in_ob_zone' },
    { symbol: 'CCC', direction: null, stage: 'data', outcome: 'rejected', reasonCode: 'DATA_GAP' },
    { symbol: 'AAA', direction: 'LONG', stage: 'entry', outcome: 'executed', reasonCode: 'opened' },
  ]);
  assert.equal(rows.find(r => r.reason_code === 'not_selected').count, 2);
  const s = summarizeOutcomes(rows);
  assert.deepEqual(s.overall, { 'rejected:not_selected': 2, 'rejected:funding_filter': 1, 'watch:not_in_ob_zone': 1, 'rejected:DATA_GAP': 1 });
  assert.deepEqual(s.byDirection.LONG, { 'rejected:not_selected': 2 });
  assert.deepEqual(s.byDirection.SHORT, { 'rejected:funding_filter': 1, 'watch:not_in_ob_zone': 1 });
  assert.deepEqual(Object.keys(s.bySymbol), ['AAA', 'BBB', 'CCC']);
});

// ── End to end: run a backtest on an in-memory DB, then build the report ─────

function installBacktestDb(strat, id) {
  const db = { run: null, balance: null, positions: [] };
  installFakePool((text, p) => {
    if (/LIKE 'strategy:%'/.test(text)) return [{ key: `strategy:${id}`, value: strat }];
    if (/key = \$1/.test(text) && p[0] === `strategy:${id}`) return [{ value: strat }];
    if (/INSERT INTO backtest_runs/.test(text)) {
      db.run = { id: 1, label: p[0], strategy_id: p[1], symbols_json: JSON.parse(p[2]), date_from_ms: String(p[3]), date_to_ms: String(p[4]),
        starting_balance: String(p[5]), fee_percent: String(p[6]), slippage_percent: String(p[7]), status: 'running' };
      return [{ id: 1 }];
    }
    if (/INSERT INTO backtest_positions/.test(text)) {
      db.positions.push({ id: db.positions.length + 1, symbol: p[1], signal_type: p[2], direction: p[3], entry_usdt: String(p[6]),
        fee_usdt: String(p[9]), slippage_usdt: String(p[10]), status: 'open', opened_at_ms: String(p[11]), risk_usdt: String(p[13]) });
      return [{ id: db.positions.length }];
    }
    if (/UPDATE backtest_positions/.test(text)) {
      const row = db.positions.find(r => r.id === p[6]);
      Object.assign(row, { status: 'closed', exit_price: String(p[0]), exit_reason: p[1], pnl_percent: String(p[2]), pnl_usdt: String(p[3]),
        fee_usdt: String(Number(row.fee_usdt) + p[4]), closed_at_ms: String(p[5]), slippage_usdt: String(Number(row.slippage_usdt) + p[7]), pnl_r: p[8] === null ? null : String(p[8]) });
      return [];
    }
    if (/UPDATE backtest_balance/.test(text)) { db.balance = { balance_usdt: String(p[0]), equity_curve_json: JSON.parse(p[8]) }; return []; }
    if (/SET signal_outcomes_json/.test(text)) { db.run.signal_outcomes_json = JSON.parse(p[0]); return []; }
    if (/UPDATE backtest_runs/.test(text)) { db.run.status = p[0]; return []; }
    if (/FROM backtest_runs/.test(text)) return [db.run];
    if (/FROM backtest_balance/.test(text)) return [db.balance];
    if (/FROM backtest_positions/.test(text)) return [...db.positions];
    return [];
  });
  return db;
}

test('report after a backtest: trades, R, exits and rejected signals per reason, per symbol and direction', async () => {
  const D = Date.UTC(2026, 0, 10);
  const strat = { signal_types: 'volume_spike', min_volume_spike_ratio: 3, leverage: 5, tp_percent: 2, sl_percent: -1.5, max_hold_ms: 4 * H1, max_open_positions: 5 };
  const db = installBacktestDb(strat, 'report_test');
  const restore = stubHistory({
    AAA: [{ spikeAt: D + 30 * 60_000, stopOut: true }],
    BBB: [{ spikeAt: D + 30 * 60_000 }],                 // same cycle as AAA → not_selected
    CCC: [{ spikeAt: D + 2 * H1, short: true, stopOut: true }],
  });
  const log = console.log; console.log = () => {};
  try {
    await runBacktest({ strategyId: 'report_test', symbols: ['AAA', 'BBB', 'CCC'], dateFromMs: D, dateToMs: D + 8 * H1,
      startingBalance: 1000, cacheDir: mkdtempSync(join(tmpdir(), 'charon-bt-')) });
  } finally { console.log = log; restore(); }

  const report = await buildBacktestReport(1);
  const closed = db.positions.filter(p => p.status === 'closed');
  assert.equal(report.overall.trades, closed.length);
  assert.ok(closed.length >= 2);
  close(report.overall.expectancyR, closed.reduce((n, p) => n + Number(p.pnl_r), 0) / closed.length, 1e-9);
  assert.ok(report.overall.expectancyR < -1, 'two stop-outs lose more than 1R each after costs');
  assert.equal(report.overall.exits.SL, 2);
  assert.equal(report.byDirection.get('LONG').trades, 1);
  assert.equal(report.byDirection.get('SHORT').trades, 1);
  assert.deepEqual([...report.bySymbol.keys()].sort(), ['AAA', 'CCC']);
  assert.equal(report.signals.overall['rejected:not_selected'], 1);
  assert.deepEqual(report.signals.bySymbol.BBB, { 'rejected:not_selected': 1 });

  const text = formatBacktestReport(report);
  for (const needle of ['SUMMARY', 'BY DIRECTION', 'BY SYMBOL', 'SIGNALS NOT TAKEN', 'not_selected', 'Expectancy:', 'Profit factor:', 'Max drawdown:', 'LIQ_GUARD 0']) {
    assert.ok(text.includes(needle), `report text missing "${needle}"`);
  }
});
