import { query as pgQuery } from './pg-connection.js';
import { now, json } from '../utils.js';
import { TRADING_MODE } from '../config.js';
import { reserveMargin, releaseMargin, canOpenPosition } from './virtualBalance.js';

export async function positionById(id) {
  try {
    const result = await pgQuery("SELECT * FROM positions WHERE id = $1", [id]);
    return result.rows[0] || null;
  } catch (err) {
    console.error('[positions] positionById failed:', err.message);
    return null;
  }
}

export async function openPositions() {
  try {
    const result = await pgQuery("SELECT * FROM positions WHERE status = 'open'");
    return result.rows;
  } catch (err) {
    console.error('[positions] openPositions failed:', err.message);
    return [];
  }
}

export async function openPositionCount() {
  try {
    const result = await pgQuery("SELECT COUNT(*) as c FROM positions WHERE status = 'open'");
    return parseInt(result.rows[0]?.c || 0);
  } catch (err) {
    console.error('[positions] openPositionCount failed:', err.message);
    return 0;
  }
}

export async function canOpenMorePositions(maxPositions = 3) {
  const count = await openPositionCount();
  return count < maxPositions;
}

export function tradingMode() {
  return TRADING_MODE;
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
  try {
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

    // Create position in PostgreSQL
    const result = await pgQuery(`
      INSERT INTO positions (
        candidate_id, symbol, direction, leverage, margin_type,
        entry_price, entry_usdt, notional_usdt,
        tp_percent, sl_percent, trailing_enabled, trailing_percent,
        high_water_price, low_water_price, liq_price,
        status, execution_mode, opened_at_ms, strategy_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'open','dry_run',$16,$17)
      RETURNING id
    `, [
      candidateId, candidate.symbol, decision.direction,
      candidate.leverage || 1, candidate.marginType || 'ISOLATED',
      entryPrice, candidate.entryUsdt, candidate.entryUsdt,
      tpPercent, slPercent, false, 0,
      entryPrice, entryPrice,
      candidate.metrics.liqPrice || null,
      now(), candidate.strategyId,
    ]);
    
    console.log(`[dry_run] Reserved ${marginRequired.toFixed(2)} USDT margin for position ${result.rows[0]?.id}`);
    return result.rows[0]?.id;
  } catch (err) {
    console.error('[positions] createDryRunPosition failed:', err.message);
    throw err;
  }
}

export async function createLivePosition(candidateId, candidate, decision, orderId) {
  try {
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

    const result = await pgQuery(`
      INSERT INTO positions (
        candidate_id, symbol, direction, leverage, margin_type,
        entry_price, entry_usdt, notional_usdt,
        tp_percent, sl_percent, trailing_enabled, trailing_percent,
        high_water_price, low_water_price, liq_price,
        status, execution_mode, binance_order_id, opened_at_ms, strategy_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'open','live',$16,$17,$18)
      RETURNING id
    `, [
      candidateId, candidate.symbol, decision.direction,
      candidate.leverage || 1, candidate.marginType || 'ISOLATED',
      entryPrice, candidate.entryUsdt, candidate.entryUsdt,
      tpPercent, slPercent, false, 0,
      entryPrice, entryPrice,
      candidate.metrics.liqPrice || null,
      orderId || null, now(), candidate.strategyId,
    ]);
    return result.rows[0]?.id;
  } catch (err) {
    console.error('[positions] createLivePosition failed:', err.message);
    throw err;
  }
}

export async function closePosition(id, exitPrice, exitReason, pnlPercent, pnlUsdt, signature = null) {
  try {
    // Get position info before closing
    const posResult = await pgQuery("SELECT * FROM positions WHERE id = $1", [id]);
    
    if (posResult.rows.length === 0) {
      throw new Error(`Position ${id} not found`);
    }
    
    const position = posResult.rows[0];
    
    await pgQuery(`
      UPDATE positions
      SET status = 'closed', closed_at_ms = $1, exit_price = $2, exit_reason = $3,
          pnl_percent = $4, pnl_usdt = $5, binance_order_id = COALESCE($6, binance_order_id)
      WHERE id = $7
    `, [now(), exitPrice, exitReason, pnlPercent, pnlUsdt, signature, id]);
    
    // Release margin for dry_run positions
    if (position.execution_mode === 'dry_run') {
      const marginUsed = position.entry_usdt || 0;
      await releaseMargin(marginUsed, pnlUsdt || 0);
      console.log(`[dry_run] Released ${marginUsed.toFixed(2)} USDT margin, PnL: ${(pnlUsdt || 0).toFixed(2)} USDT`);
    }
  } catch (err) {
    console.error('[positions] closePosition failed:', err.message);
    throw err;
  }
}

export async function updatePositionWatermarks(id, highWater, lowWater, trailingArmed) {
  try {
    await pgQuery(`
      UPDATE positions SET high_water_price = $1, low_water_price = $2, trailing_armed = $3 WHERE id = $4
    `, [highWater, lowWater, trailingArmed ? true : false, id]);
  } catch (err) {
    console.error('[positions] updatePositionWatermarks failed:', err.message);
  }
}

export async function logTrade(positionId, symbol, direction, side, price, pnlPercent, pnlUsdt, reason, payload) {
  try {
    await pgQuery(`
      INSERT INTO trades (position_id, symbol, direction, side, at_ms, price, pnl_percent, pnl_usdt, reason, payload_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    `, [positionId, symbol, direction, side, now(), price, pnlPercent, pnlUsdt, reason, json(payload)]);
  } catch (err) {
    console.error('[positions] logTrade failed:', err.message);
  }
}

export async function pnlSummary() {
  try {
    const result = await pgQuery(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'closed' AND pnl_usdt > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN status = 'closed' AND pnl_usdt <= 0 THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN status = 'closed' THEN pnl_usdt ELSE 0 END) as total_pnl_usdt,
        COUNT(CASE WHEN status = 'open' THEN 1 END) as open_count
      FROM positions
    `);
    return result.rows[0] || {};
  } catch (err) {
    console.error('[positions] pnlSummary failed:', err.message);
    return {};
  }
}

export async function recentClosedPositions(limit = 10) {
  try {
    const result = await pgQuery(`
      SELECT pnl_usdt, pnl_percent, symbol, direction, exit_reason, closed_at_ms
      FROM positions 
      WHERE execution_mode = 'dry_run' AND status = 'closed'
      ORDER BY closed_at_ms DESC 
      LIMIT $1
    `, [limit]);
    return result.rows;
  } catch (err) {
    console.error('[positions] recentClosedPositions failed:', err.message);
    return [];
  }
}
