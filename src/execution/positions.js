import { now } from '../utils.js';
import { openPositions, closePosition, updatePositionWatermarks, updateLastCandleChecked, logTrade } from '../db/positions.js';
import { strategyById } from '../db/settings.js';
import { fetchPremiumIndex, fetchKlinesRange } from '../enrichment/binance.js';
import { sendPositionExit, sendTelegram } from '../telegram/send.js';
import { executeFuturesSell, cancelAllOrders } from './futuresExecutor.js';
import { isMaxHoldHit } from './exitRules.js';
import { exitQuantity } from './positionMath.js';
import { evaluateExit, settleExit, levelsFromPercents } from './simulation.js';
import { SIM_SLIPPAGE_PERCENT, SIM_TAKER_FEE_PERCENT } from '../config.js';

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

  if (position.execution_mode === 'dry_run') {
    return refreshDryRunPosition(position, markPrice, autoExit);
  }

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
  const strat = await strategyById(position.strategy_id);
  const maxHoldHit = isMaxHoldHit(strat, position.opened_at_ms, now());

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
    if (liqHit) exitReason = 'LIQ_GUARD';
  }

  updatePositionWatermarks(position.id, highWater, lowWater, trailingArmed);

  if (exitReason && autoExit) {
    return exitLive(position, exitReason, markPrice);
  }

  console.log(`[position] #${position.id} ${position.symbol} ${position.direction} | mark=${markPrice} pnl=${pnlPercent.toFixed(2)}%`);
  return { ...position, markPrice, pnlPercent, pnlUsdt, highWater, lowWater };
}

/**
 * Close a live position with a reduce-only MARKET order for the full entry quantity.
 */
async function exitLive(position, exitReason, markPrice) {
  if (sellInProgress.has(position.id)) return { ...position, exitReason: null };
  sellInProgress.add(position.id);
  const isLong = position.direction === 'LONG';
  const entryPrice = Number(position.entry_price);
  try {
    // Close exactly the quantity opened (already rounded to stepSize at entry)
    const sell = await executeFuturesSell(position.symbol, position.direction, exitQuantity(position));
    await cancelAllOrders(position.symbol);
    const exitPrice = sell.fillPrice || markPrice;
    const realPricePct = isLong ? (exitPrice / entryPrice - 1) * 100 : (1 - exitPrice / entryPrice) * 100;
    const pnlPercent = realPricePct * Number(position.leverage || 1);
    const pnlUsdt = Number(position.entry_usdt) * (pnlPercent / 100);

    await closePosition(position.id, exitPrice, exitReason, pnlPercent, pnlUsdt);
    logTrade(position.id, position.symbol, position.direction, 'sell', exitPrice,
      pnlPercent, pnlUsdt, exitReason, { pnlPercent, pnlUsdt });
    await sendPositionExit({ ...position, pnlPercent, pnlUsdt, exitReason, exit_price: exitPrice, markPrice: exitPrice });
    return { ...position, exitReason };
  } catch (err) {
    console.log(`[position] ${position.id} close failed: ${err.message}`);
    return null;
  } finally {
    sellInProgress.delete(position.id);
  }
}

function dryRunLevels(position) {
  return Number(position.stop_loss_price) > 0 && Number(position.take_profit_price) > 0
    ? { stopLoss: Number(position.stop_loss_price), takeProfit: Number(position.take_profit_price) }
    : levelsFromPercents(position.direction, Number(position.entry_price), Number(position.tp_percent), Number(position.sl_percent));
}

/**
 * Dry-run exit check. SL/TP/liq-guard are detected on closed 1m candle
 * high/low since the last check (SL wins if both are touched in one candle);
 * MAX_HOLD exits at the current mark price. Exits pay simulated slippage and
 * both sides pay the taker fee.
 */
async function refreshDryRunPosition(position, markPrice, autoExit) {
  const t = now();
  const direction = position.direction;
  const entryPrice = Number(position.entry_price);
  const levels = dryRunLevels(position);

  // Fetch closed 1m candles at most once per minute (one new candle per minute)
  let candles1m = [];
  const lastChecked = Number(position.last_candle_checked_ms) || Number(position.opened_at_ms);
  if (t - lastChecked >= 60_000) {
    try {
      candles1m = await fetchKlinesRange(position.symbol, '1m', lastChecked, t, { pauseMs: 0 });
    } catch (err) {
      console.log(`[position] #${position.id} 1m kline fetch failed: ${err.message}`);
    }
  }

  const strat = await strategyById(position.strategy_id);
  const { trigger, lastCheckedMs } = evaluateExit(
    { direction, ...levels, liqPrice: Number(position.liq_price) || null,
      openedAtMs: Number(position.opened_at_ms), lastCheckedMs: Number(position.last_candle_checked_ms) || 0 },
    candles1m,
    { nowMs: t, maxHoldMs: Number(strat?.max_hold_ms) || 0, maxHoldPrice: markPrice },
  );
  if (!trigger && lastCheckedMs > (Number(position.last_candle_checked_ms) || 0)) {
    await updateLastCandleChecked(position.id, lastCheckedMs);
  }

  const isLong = direction === 'LONG';
  const pricePct = isLong ? (markPrice / entryPrice - 1) * 100 : (1 - markPrice / entryPrice) * 100;
  const pnlPercent = pricePct * Number(position.leverage || 1);
  const pnlUsdt = Number(position.entry_usdt) * (pnlPercent / 100);
  const highWater = Math.max(Number(position.high_water_price || entryPrice), markPrice);
  const lowWater = Math.min(Number(position.low_water_price || entryPrice), markPrice);
  updatePositionWatermarks(position.id, highWater, lowWater, position.trailing_armed);

  if (!trigger || !autoExit) {
    console.log(`[position] #${position.id} ${position.symbol} ${direction} | mark=${markPrice} pnl=${pnlPercent.toFixed(2)}%`);
    return { ...position, markPrice, pnlPercent, pnlUsdt, highWater, lowWater };
  }

  return exitDryRun(position, trigger, markPrice);
}

/**
 * Close a dry-run position at trigger.exitPriceRaw: adverse slippage on the
 * exit, taker fee on both sides, PnL in USDT and R.
 */
async function exitDryRun(position, trigger, markPrice) {
  const direction = position.direction;
  const entryPrice = Number(position.entry_price);
  const quantity = exitQuantity(position);
  const levels = dryRunLevels(position);
  if (sellInProgress.has(position.id)) return { ...position, exitReason: null };
  sellInProgress.add(position.id);
  try {
    const pnl = settleExit({
      direction, entryPrice, quantity,
      entryMarkPrice: Number(position.entry_mark_price) || entryPrice,
      riskUsdt: Number(position.risk_usdt) || quantity * Math.abs(entryPrice - levels.stopLoss),
      marginUsdt: Number(position.entry_usdt),
    }, trigger, { slippagePercent: SIM_SLIPPAGE_PERCENT, feePercent: SIM_TAKER_FEE_PERCENT });
    const { exitPrice } = pnl;
    await closePosition(position.id, exitPrice, trigger.exitReason, pnl.pnlPercent, pnl.pnlUsdt, null, {
      exitPriceRaw: trigger.exitPriceRaw, entryFeeUsdt: pnl.entryFeeUsdt, exitFeeUsdt: pnl.exitFeeUsdt,
      slippageUsdt: pnl.slippageUsdt, pnlR: pnl.pnlR,
    });
    logTrade(position.id, position.symbol, direction, 'sell', exitPrice, pnl.pnlPercent, pnl.pnlUsdt, trigger.exitReason, {
      entryPrice, exitPrice, exitPriceRaw: trigger.exitPriceRaw, quantity, ...pnl,
      stopLoss: levels.stopLoss, takeProfit: levels.takeProfit, candleOpenTime: trigger.candle?.openTime ?? null,
    });
    const closed = { ...position, pnlPercent: pnl.pnlPercent, pnlUsdt: pnl.pnlUsdt, exitReason: trigger.exitReason, exit_price: exitPrice, markPrice };
    await sendPositionExit(closed);
    return { ...position, exitReason: trigger.exitReason };
  } catch (err) {
    console.log(`[position] #${position.id} dry-run close failed: ${err.message}`);
    return null;
  } finally {
    sellInProgress.delete(position.id);
  }
}

/**
 * Close one open position immediately at market (manual / kill switch).
 * @returns {Promise<object|null>} closed position, or null on failure
 */
export async function closePositionNow(position, exitReason = 'MANUAL') {
  const markPrice = Number((await fetchPremiumIndex(position.symbol)).markPrice);
  if (!(markPrice > 0)) throw new Error(`no mark price for ${position.symbol}`);
  return position.execution_mode === 'dry_run'
    ? exitDryRun(position, { exitReason, exitPriceRaw: markPrice }, markPrice)
    : exitLive(position, exitReason, markPrice);
}

/**
 * Close every open position. Returns { closed: [...symbols], failed: [{symbol, error}] }.
 */
export async function closeAllPositions(exitReason = 'MANUAL') {
  const closed = [];
  const failed = [];
  for (const pos of await openPositions()) {
    try {
      const res = await closePositionNow(pos, exitReason);
      if (res?.exitReason) closed.push(pos.symbol);
      else failed.push({ symbol: pos.symbol, error: 'close did not complete' });
    } catch (err) {
      failed.push({ symbol: pos.symbol, error: err.message });
    }
  }
  return { closed, failed };
}

/**
 * Monitor all open positions.
 */
export async function monitorPositions() {
  const positions = await openPositions();
  for (const pos of positions) {
    await refreshPosition(pos).catch(err => {
      console.log(`[position] #${pos.id} monitor error: ${err.message}`);
    });
  }
}
