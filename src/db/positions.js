import { db } from './connection.js';
import { pool } from './pg-connection.js';
import { now, json } from '../utils.js';
import { TRADING_MODE } from '../config.js';
import { reserveMargin, releaseMargin, canOpenPosition } from './virtualBalance.js';

// Check if we're using PostgreSQL
const USE_POSTGRES = process.env.USE_POSTGRES === 'true';

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

/**
 * Calculate raw price % from entry to SL/TP for storage in DB.
 *
 * Convention (used by positions.js for exit checks):
 *   LONG:  tpPercent > 0 (price goes up),  slPercent < 0 (price goes down)
 *   SHORT: tpPercent > 0 (price goes down), slPercent < 0 (price goes up past SL)
 *
 * For SHORT, pricePct = (1 - markPrice/entryPrice) * 100
 *   → positive when price drops (profit), negative when price rises (loss)
 *   → SL triggers when pricePct <= slPercent (negative threshold)
 *   → So slPercent for SHORT = (1 - stopLoss/entry) * 100  → negative because stopLoss > entry
 */
function calcTpSlPercent(direction, entryPrice, stopLoss, takeProfit) {
  if (direction === 'LONG') {
    // LONG: profit when price rises
    const tpPercent = (takeProfit - entryPrice) / entryPrice * 100;  // positive
    const slPercent = (stopLoss - entryPrice) / entryPrice * 100;    // negative (SL < entry)
    return { tpPercent, slPercent };
  } else {
    // SHORT: profit when price falls
    // positions.js uses: pricePct = (1 - markPrice/entryPrice) * 100
    // TP: price falls to takeProfit → pricePct = (1 - takeProfit/entry) * 100 → positive
    // SL: price rises to stopLoss  → pricePct = (1 - stopLoss/entry) * 100   → negative
    const tpPercent = (1 - takeProfit / entryPrice) * 100;  // positive (takeProfit < entry)
    const slPercent = (1 - stopLoss / entryPrice) * 100;    // negative (stopLoss > entry)
    return { tpPercent, slPercent };
  }
}

export async function createDryRunPosition(candidateId, candidate, decision) {
  const entryPrice = candidate.metrics.markPrice;
  const obMeta = candidate.signals?.meta || {};

  let tpPercent, slPercent;
  if (obMeta.stopLoss && obMeta.takeProfit && entryPrice > 0) {
    ({ tpPercent, slPercent } = calcTpSlPercent(
      decision.direction, entryPrice, obMeta.stopLoss, obMeta.takeProfit
    ));
  } else {
    tpPercent = decision.suggested_tp_percent;
    slPercent = decision.suggested_sl_percent;
  }

  // Calculate margin requirement for dry_run
  const marginRequired = candidate.entryUsdt || 0;
  
  // Check virtual balance before opening position
  if (!(await canOpenPosition(marginRequired))) {
    throw new Error(`Insufficient virtual balance for ${candidate.symbol} ${decision.direction} position (${marginRequired.toFixed(2)} USDT required)`);
  }
  
  // Reserve margin in virtual balance
  await reserveMargin(marginRequired);

  // Create position in SQLite (for compatibility)
  const result = db.prepare(`
    INSERT INTO positions (
      candidate_id, symbol, direction, leverage, margin_type,
      entry_price, entry_usdt, notional_usdt,
      tp_percent, sl_percent, trailing_enabled, trailing_percent,
      high_water_price, low_water_price, liq_price,
      status, execution_mode, opened_at_ms, strategy_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open','dry_run',?,?)
  `).run(
    candidateId, candidate.symbol, decision.direction,
    candidate.leverage || 1, candidate.marginType || 'ISOLATED',
    entryPrice, candidate.entryUsdt, candidate.entryUsdt,
    tpPercent, slPercent, 0, 0,
    entryPrice, entryPrice,
    candidate.metrics.liqPrice || null,
    now(), candidate.strategyId,
  );
  
  console.log(`[dry_run] Reserved ${marginRequired.toFixed(2)} USDT margin for position ${result.lastInsertRowid}`);
  return result.lastInsertRowid;
}

export function createLivePosition(candidateId, candidate, decision, orderId) {
  const entryPrice = candidate.metrics.markPrice;
  const obMeta = candidate.signals?.meta || {};

  let tpPercent, slPercent;
  if (obMeta.stopLoss && obMeta.takeProfit && entryPrice > 0) {
    ({ tpPercent, slPercent } = calcTpSlPercent(
      decision.direction, entryPrice, obMeta.stopLoss, obMeta.takeProfit
    ));
  } else {
    tpPercent = decision.suggested_tp_percent;
    slPercent = decision.suggested_sl_percent;
  }

  const result = db.prepare(`
    INSERT INTO positions (
      candidate_id, symbol, direction, leverage, margin_type,
      entry_price, entry_usdt, notional_usdt,
      tp_percent, sl_percent, trailing_enabled, trailing_percent,
      high_water_price, low_water_price, liq_price,
      status, execution_mode, binance_order_id, opened_at_ms, strategy_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open','live',?,?,?)
  `).run(
    candidateId, candidate.symbol, decision.direction,
    candidate.leverage || 1, candidate.marginType || 'ISOLATED',
    entryPrice, candidate.entryUsdt, candidate.entryUsdt,
    tpPercent, slPercent, 0, 0,
    entryPrice, entryPrice,
    candidate.metrics.liqPrice || null,
    orderId || null, now(), candidate.strategyId,
  );
  return result.lastInsertRowid;
}

export async function closePosition(id, exitPrice, exitReason, pnlPercent, pnlUsdt, signature = null) {
  // Get position info before closing
  const position = db.prepare("SELECT * FROM positions WHERE id = ?").get(id);
  
  if (!position) {
    throw new Error(`Position ${id} not found`);
  }
  
  db.prepare(`
    UPDATE positions
    SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_reason = ?,
        pnl_percent = ?, pnl_usdt = ?, binance_order_id = COALESCE(?, binance_order_id)
    WHERE id = ?
  `).run(now(), exitPrice, exitReason, pnlPercent, pnlUsdt, signature, id);
  
  // Release margin for dry_run positions
  if (position.execution_mode === 'dry_run') {
    const marginUsed = position.entry_usdt || 0;
    await releaseMargin(marginUsed, pnlUsdt || 0);
    console.log(`[dry_run] Released ${marginUsed.toFixed(2)} USDT margin, PnL: ${(pnlUsdt || 0).toFixed(2)} USDT`);
  }
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
