import { db } from './connection.js';
import { now, json } from '../utils.js';
import { TRADING_MODE } from '../config.js';

export function tradingMode() {
  return TRADING_MODE;
}

export function openPositions() {
  return db.prepare("SELECT * FROM positions WHERE status = 'open'").all();
}

export function openPositionCount() {
  return db.prepare("SELECT COUNT(*) as c FROM positions WHERE status = 'open'").get().c;
}

export function canOpenMorePositions(maxPositions = 3) {
  return openPositionCount() < maxPositions;
}

export function createDryRunPosition(candidateId, candidate, decision) {
  const result = db.prepare(`
    INSERT INTO positions (
      candidate_id, symbol, direction, leverage, margin_type,
      entry_price, entry_usdt, notional_usdt,
      tp_percent, sl_percent, trailing_enabled, trailing_percent,
      high_water_price, low_water_price, liq_price,
      status, execution_mode, opened_at_ms, strategy_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open','dry_run',?,?)
  `).run(
    candidateId,
    candidate.symbol,
    decision.direction,
    candidate.leverage || 1,
    candidate.marginType || 'ISOLATED',
    candidate.metrics.markPrice,
    candidate.entryUsdt,
    candidate.metrics.markPrice * (candidate.entryUsdt / candidate.metrics.markPrice),
    decision.suggested_tp_percent,
    decision.suggested_sl_percent,
    0,
    0,
    candidate.metrics.markPrice,
    candidate.metrics.markPrice,
    candidate.metrics.liqPrice || null,
    now(),
    candidate.strategyId,
  );
  return result.lastInsertRowid;
}

export function createLivePosition(candidateId, candidate, decision, orderId) {
  const result = db.prepare(`
    INSERT INTO positions (
      candidate_id, symbol, direction, leverage, margin_type,
      entry_price, entry_usdt, notional_usdt,
      tp_percent, sl_percent, trailing_enabled, trailing_percent,
      high_water_price, low_water_price, liq_price,
      status, execution_mode, binance_order_id, opened_at_ms, strategy_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open','live',?,?,?)
  `).run(
    candidateId,
    candidate.symbol,
    decision.direction,
    candidate.leverage || 1,
    candidate.marginType || 'ISOLATED',
    candidate.metrics.markPrice,
    candidate.entryUsdt,
    candidate.metrics.markPrice * (candidate.entryUsdt / candidate.metrics.markPrice),
    decision.suggested_tp_percent,
    decision.suggested_sl_percent,
    0,
    0,
    candidate.metrics.markPrice,
    candidate.metrics.markPrice,
    candidate.metrics.liqPrice || null,
    orderId || null,
    now(),
    candidate.strategyId,
  );
  return result.lastInsertRowid;
}

export function closePosition(id, exitPrice, exitReason, pnlPercent, pnlUsdt, signature = null) {
  db.prepare(`
    UPDATE positions
    SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_reason = ?,
        pnl_percent = ?, pnl_usdt = ?, binance_order_id = COALESCE(?, binance_order_id)
    WHERE id = ?
  `).run(now(), exitPrice, exitReason, pnlPercent, pnlUsdt, signature, id);
}

export function updatePositionWatermarks(id, highWater, lowWater, trailingArmed) {
  db.prepare(`
    UPDATE positions SET high_water_price = ?, low_water_price = ?, trailing_armed = ? WHERE id = ?
  `).run(highWater, lowWater, trailingArmed ? 1 : 0, id);
}

export function logTrade(positionId, symbol, direction, side, price, pnlPercent, pnlUsdt, reason, payload) {
  db.prepare(`
    INSERT INTO trades (position_id, symbol, direction, side, at_ms, price, pnl_percent, pnl_usdt, reason, payload_json)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(positionId, symbol, direction, side, now(), price, pnlPercent, pnlUsdt, reason, json(payload));
}

export function pnlSummary() {
  return db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'closed' AND pnl_usdt > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN status = 'closed' AND pnl_usdt <= 0 THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN status = 'closed' THEN pnl_usdt ELSE 0 END) as total_pnl_usdt,
      COUNT(CASE WHEN status = 'open' THEN 1 END) as open_count
    FROM positions
  `).get();
}
