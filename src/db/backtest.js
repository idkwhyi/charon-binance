import { query as pgQuery } from './pg-connection.js';
import { now, json } from '../utils.js';

export async function createBacktestRun({
  label, strategyId, symbols, dateFromMs, dateToMs,
  startingBalance, feePercent, slippagePercent, params,
}) {
  const result = await pgQuery(`
    INSERT INTO backtest_runs (
      label, strategy_id, symbols_json, date_from_ms, date_to_ms,
      starting_balance, fee_percent, slippage_percent, params_json,
      status, started_at_ms, created_at_ms
    ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9::jsonb,'running',$10,$11)
    RETURNING id
  `, [
    label, strategyId, json(symbols), dateFromMs, dateToMs,
    startingBalance, feePercent, slippagePercent, json(params || {}),
    now(), now(),
  ]);
  const runId = result.rows[0].id;

  await pgQuery(`
    INSERT INTO backtest_balance (run_id, balance_usdt, available_balance, peak_balance)
    VALUES ($1, $2, $2, $2)
  `, [runId, startingBalance]);

  return runId;
}

export async function finishBacktestRun(runId, status, error = null) {
  await pgQuery(`
    UPDATE backtest_runs SET status = $1, error = $2, finished_at_ms = $3 WHERE id = $4
  `, [status, error, now(), runId]);
}

export async function openBacktestPosition(runId, pos) {
  const result = await pgQuery(`
    INSERT INTO backtest_positions (
      run_id, symbol, signal_type, direction, leverage,
      entry_price, entry_usdt, tp_percent, sl_percent,
      fee_usdt, slippage_usdt, status, opened_at_ms, candidate_snapshot_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',$12,$13::jsonb)
    RETURNING id
  `, [
    runId, pos.symbol, pos.signalType, pos.direction, pos.leverage,
    pos.entryPrice, pos.entryUsdt, pos.tpPercent, pos.slPercent,
    pos.feeUsdt, pos.slippageUsdt, pos.openedAtMs, json(pos.candidateSnapshot || {}),
  ]);
  return result.rows[0].id;
}

export async function closeBacktestPosition(id, { exitPrice, exitReason, pnlPercent, pnlUsdt, feeUsdt, closedAtMs }) {
  await pgQuery(`
    UPDATE backtest_positions
    SET status = 'closed', exit_price = $1, exit_reason = $2,
        pnl_percent = $3, pnl_usdt = $4, fee_usdt = fee_usdt + $5, closed_at_ms = $6
    WHERE id = $7
  `, [exitPrice, exitReason, pnlPercent, pnlUsdt, feeUsdt, closedAtMs, id]);
}

export async function saveBacktestBalance(runId, balance) {
  await pgQuery(`
    UPDATE backtest_balance SET
      balance_usdt = $1, available_balance = $2, margin_used = $3,
      total_trades = $4, winning_trades = $5, losing_trades = $6,
      max_drawdown_percent = $7, peak_balance = $8,
      equity_curve_json = $9::jsonb, updated_at = CURRENT_TIMESTAMP
    WHERE run_id = $10
  `, [
    balance.balanceUsdt, balance.availableBalance, balance.marginUsed,
    balance.totalTrades, balance.winningTrades, balance.losingTrades,
    balance.maxDrawdownPercent, balance.peakBalance,
    json(balance.equityCurve), runId,
  ]);
}

export async function getBacktestRun(runId) {
  const result = await pgQuery('SELECT * FROM backtest_runs WHERE id = $1', [runId]);
  return result.rows[0] || null;
}

export async function getBacktestBalance(runId) {
  const result = await pgQuery('SELECT * FROM backtest_balance WHERE run_id = $1', [runId]);
  return result.rows[0] || null;
}

export async function getBacktestPositions(runId, status = null) {
  const sql = status
    ? 'SELECT * FROM backtest_positions WHERE run_id = $1 AND status = $2 ORDER BY opened_at_ms'
    : 'SELECT * FROM backtest_positions WHERE run_id = $1 ORDER BY opened_at_ms';
  const params = status ? [runId, status] : [runId];
  const result = await pgQuery(sql, params);
  return result.rows;
}
