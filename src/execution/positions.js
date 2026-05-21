import { now } from '../utils.js';
import { openPositions, closePosition, updatePositionWatermarks, logTrade } from '../db/positions.js';
import { strategyById } from '../db/settings.js';
import { fetchPremiumIndex } from '../enrichment/binance.js';
import { sendPositionExit, sendTelegram } from '../telegram/send.js';
import { executeFuturesSell, cancelAllOrders } from './futuresExecutor.js';

const sellInProgress = new Set();

/**
 * Refresh a single position and check for exit conditions.
 */
export async function refreshPosition(position, autoExit = true) {
  // Fetch current mark price
  let markPrice = null;
  try {
    const premium = await fetchPremiumIndex(position.symbol);
    markPrice = Number(premium.markPrice || 0);
  } catch (err) {
    console.log(`[position] ${position.id} price fetch failed: ${err.message}`);
    return null;
  }

  if (!markPrice || markPrice <= 0) return null;

  const isLong = position.direction === 'LONG';
  const entryPrice = Number(position.entry_price);
  if (!entryPrice || entryPrice <= 0) return null;

  // P&L calculation — based on raw price movement, NOT leveraged
  // Leverage only affects margin efficiency, not the SL/TP price levels
  const pricePct = isLong
    ? (markPrice / entryPrice - 1) * 100
    : (1 - markPrice / entryPrice) * 100;

  // For display purposes, show leveraged PnL on the margin used
  const pnlPercent = pricePct * Number(position.leverage || 1);
  const pnlUsdt = Number(position.entry_usdt) * (pnlPercent / 100);

  // Watermarks
  const highWater = Math.max(Number(position.high_water_price || entryPrice), markPrice);
  const lowWater = Math.min(Number(position.low_water_price || entryPrice), markPrice);

  // Trailing
  const trailingArmed = position.trailing_armed || (position.trailing_enabled && pricePct >= Number(position.tp_percent));
  const trailRef = isLong ? highWater : lowWater;
  const trailDrop = isLong
    ? (markPrice / trailRef - 1) * 100
    : (trailRef / markPrice - 1) * 100;
  const trailingHit = trailingArmed && position.trailing_enabled
    && trailDrop <= -Math.abs(Number(position.trailing_percent));

  // Exit conditions — compare raw price % (not leveraged) against tp/sl thresholds
  // tp_percent and sl_percent stored in DB are raw price % from entry
  const tpHit = pricePct >= Number(position.tp_percent);
  const slHit = pricePct <= Number(position.sl_percent);

  // Max hold time
  const strat = strategyById(position.strategy_id);
  const maxHoldHit = strat?.max_hold_ms > 0 && (now() - position.opened_at_ms) >= strat.max_hold_ms;

  let exitReason = null;
  if (maxHoldHit) exitReason = 'MAX_HOLD';
  else if (slHit) exitReason = 'SL';
  else if (tpHit && !position.trailing_enabled) exitReason = 'TP';
  else if (trailingHit) exitReason = 'TRAILING_TP';

  // Liquidation guard (estimate)
  if (position.liq_price) {
    const liqHit = isLong
      ? markPrice <= Number(position.liq_price)
      : markPrice >= Number(position.liq_price);
    if (liqHit) exitReason = 'LIQUIDATION_GUARD';
  }

  updatePositionWatermarks(position.id, highWater, lowWater, trailingArmed);

  if (exitReason && autoExit) {
    if (sellInProgress.has(position.id)) return { ...position, exitReason: null };
    sellInProgress.add(position.id);

    let finalPnlPercent = pnlPercent;
    let finalPnlUsdt = pnlUsdt;

    try {
      if (position.execution_mode === 'live') {
        const quantity = Number(position.notional_usdt) / entryPrice;
        const sell = await executeFuturesSell(position.symbol, position.direction, quantity.toFixed(3));
        await cancelAllOrders(position.symbol);
        const realPricePct = isLong
          ? (sell.fillPrice / entryPrice - 1) * 100
          : (1 - sell.fillPrice / entryPrice) * 100;
        finalPnlPercent = realPricePct * Number(position.leverage || 1);
        finalPnlUsdt = Number(position.entry_usdt) * (finalPnlPercent / 100);
        markPrice = sell.fillPrice;
      }

      await closePosition(position.id, markPrice, exitReason, finalPnlPercent, finalPnlUsdt);
      logTrade(position.id, position.symbol, position.direction, 'sell', markPrice,
        finalPnlPercent, finalPnlUsdt, exitReason, { pnlPercent: finalPnlPercent, pnlUsdt: finalPnlUsdt });

      const closed = { ...position, pnlPercent: finalPnlPercent, pnlUsdt: finalPnlUsdt, exitReason, exit_price: markPrice, markPrice };
      await sendPositionExit(closed);
    } catch (err) {
      console.log(`[position] ${position.id} close failed: ${err.message}`);
    } finally {
      sellInProgress.delete(position.id);
    }
    return { ...position, exitReason };
  }

  console.log(`[position] #${position.id} ${position.symbol} ${position.direction} | mark=${markPrice} pnl=${pnlPercent.toFixed(2)}%`);
  return { ...position, markPrice, pnlPercent, pnlUsdt, highWater, lowWater };
}

/**
 * Monitor all open positions.
 */
export async function monitorPositions() {
  const positions = openPositions();
  for (const pos of positions) {
    await refreshPosition(pos).catch(err => {
      console.log(`[position] #${pos.id} monitor error: ${err.message}`);
    });
  }
}
