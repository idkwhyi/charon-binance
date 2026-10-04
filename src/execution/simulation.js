/**
 * Fill simulation shared by dry-run and the backtest — the single cost/exit
 * model: slippage, taker fees, and SL/TP detection on 1m candle high/low.
 * Pure functions — no DB/network — so they can be tested.
 */

import { isMaxHoldHit } from './exitRules.js';

/** Slippage always works against the position, on both entry and exit. */
export function applySlippage(price, direction, side, slippagePercent) {
  const f = Number(slippagePercent) / 100;
  const worseUp = (direction === 'LONG') === (side === 'entry'); // LONG entry / SHORT exit pay more
  return worseUp ? price * (1 + f) : price * (1 - f);
}

/**
 * Walk closed 1m candles (oldest first) and return the first exit trigger.
 *
 * - If one candle touches both SL and TP, SL wins (conservative: the intra-
 *   candle order is unknown).
 * - SL fills at the SL level, or at the candle open if price gapped through it.
 * - TP fills at the TP level (never better, even on a favorable gap).
 * - Liquidation guard (if liqPrice given) is checked first and fills at liqPrice.
 *
 * @param {object} p
 * @param {'LONG'|'SHORT'} p.direction
 * @param {number} p.stopLoss
 * @param {number} p.takeProfit
 * @param {number|null} p.liqPrice
 * @param {Array<{openTime:number, open:number, high:number, low:number, closeTime:number}>} candles
 * @returns {{ exitReason: 'LIQ_GUARD'|'SL'|'TP', exitPriceRaw: number, candle: object }|null}
 */
export function findCandleExit({ direction, stopLoss, takeProfit, liqPrice = null }, candles) {
  const isLong = direction === 'LONG';
  for (const c of candles) {
    const liq = Number(liqPrice) > 0 && (isLong ? c.low <= liqPrice : c.high >= liqPrice);
    if (liq) return { exitReason: 'LIQ_GUARD', exitPriceRaw: Number(liqPrice), candle: c };

    const slHit = isLong ? c.low <= stopLoss : c.high >= stopLoss;
    if (slHit) {
      const gapped = isLong ? c.open < stopLoss : c.open > stopLoss;
      return { exitReason: 'SL', exitPriceRaw: gapped ? c.open : stopLoss, candle: c };
    }

    const tpHit = isLong ? c.high >= takeProfit : c.low <= takeProfit;
    if (tpHit) return { exitReason: 'TP', exitPriceRaw: takeProfit, candle: c };
  }
  return null;
}

/**
 * Only candles that fully closed after the position opened (and after the
 * last one already processed) are eligible.
 */
export function eligibleCandles(candles, { openedAtMs, lastCheckedMs = 0, nowMs }) {
  const after = Math.max(Number(openedAtMs) || 0, Number(lastCheckedMs) || 0);
  return candles.filter(c => c.openTime >= after && c.closeTime < nowMs);
}

/**
 * Net PnL of a simulated round trip.
 * @param {object} p
 * @param {number} p.entryPrice - filled (slipped) entry
 * @param {number} p.exitPrice - filled (slipped) exit
 * @param {number} p.entryMarkPrice - pre-slippage entry reference
 * @param {number} p.exitPriceRaw - pre-slippage exit reference
 * @param {number} p.quantity
 * @param {number} p.feePercent - taker fee per side, in %
 * @param {number} p.riskUsdt - planned $ risk at entry (1R)
 * @param {number} p.marginUsdt
 */
export function computeTradePnl({ direction, entryPrice, exitPrice, entryMarkPrice, exitPriceRaw, quantity, feePercent, riskUsdt, marginUsdt }) {
  const sign = direction === 'LONG' ? 1 : -1;
  const grossPnlUsdt = (exitPrice - entryPrice) * quantity * sign;
  const entryFeeUsdt = entryPrice * quantity * feePercent / 100;
  const exitFeeUsdt = exitPrice * quantity * feePercent / 100;
  const slippageUsdt = (Math.abs(entryPrice - entryMarkPrice) + Math.abs(exitPrice - exitPriceRaw)) * quantity;
  const pnlUsdt = grossPnlUsdt - entryFeeUsdt - exitFeeUsdt;
  return {
    grossPnlUsdt,
    entryFeeUsdt,
    exitFeeUsdt,
    feeUsdt: entryFeeUsdt + exitFeeUsdt,
    slippageUsdt,
    pnlUsdt,
    pnlR: riskUsdt > 0 ? pnlUsdt / riskUsdt : null,
    pnlPercent: marginUsdt > 0 ? pnlUsdt / marginUsdt * 100 : 0,
  };
}

/**
 * Absolute SL/TP prices from stored raw-% thresholds (for rows created before
 * stop_loss_price/take_profit_price existed). Inverse of calcTpSlPercent in
 * src/db/positions.js.
 */
export function levelsFromPercents(direction, entryPrice, tpPercent, slPercent) {
  if (direction === 'LONG') {
    return { stopLoss: entryPrice * (1 + slPercent / 100), takeProfit: entryPrice * (1 + tpPercent / 100) };
  }
  return { stopLoss: entryPrice * (1 - slPercent / 100), takeProfit: entryPrice * (1 - tpPercent / 100) };
}

/**
 * One exit evaluation, shared by the dry-run monitor and the backtest:
 * closed 1m candles since the last check first (findCandleExit) — only up to
 * the hold limit — then MAX_HOLD at `maxHoldPrice` (dry-run: current mark;
 * backtest: last 1m close before the hold limit).
 *
 * @param {object} pos - { direction, stopLoss, takeProfit, liqPrice?, openedAtMs, lastCheckedMs? }
 * @param {Array} candles1m - 1m candles covering at least the unchecked span
 * @param {object} opts - { nowMs, maxHoldMs, maxHoldPrice }
 * @returns {{ trigger: object|null, lastCheckedMs: number }}
 */
export function evaluateExit(pos, candles1m, { nowMs, maxHoldMs = 0, maxHoldPrice = null }) {
  // Candles closing after the hold limit can't trigger SL/TP: MAX_HOLD came first
  const holdEndMs = maxHoldMs > 0 ? Number(pos.openedAtMs) + maxHoldMs : Infinity;
  const eligible = eligibleCandles(candles1m, { openedAtMs: pos.openedAtMs, lastCheckedMs: pos.lastCheckedMs, nowMs: Math.min(nowMs, holdEndMs) });
  const hit = findCandleExit(pos, eligible);
  if (hit) return { trigger: hit, lastCheckedMs: hit.candle.closeTime };

  const lastCheckedMs = eligible.length ? eligible[eligible.length - 1].closeTime : (Number(pos.lastCheckedMs) || 0);
  if (isMaxHoldHit({ max_hold_ms: maxHoldMs }, pos.openedAtMs, nowMs) && maxHoldPrice > 0) {
    return { trigger: { exitReason: 'MAX_HOLD', exitPriceRaw: maxHoldPrice }, lastCheckedMs };
  }
  return { trigger: null, lastCheckedMs };
}

/**
 * Settle a simulated exit: adverse slippage on the exit fill, taker fee on
 * both sides, PnL in USDT / % of margin / R.
 * @param {object} pos - { direction, entryPrice, entryMarkPrice, quantity, riskUsdt, marginUsdt }
 * @param {object} trigger - { exitReason, exitPriceRaw }
 * @param {object} costs - { slippagePercent, feePercent }
 */
export function settleExit(pos, trigger, { slippagePercent, feePercent }) {
  const exitPrice = applySlippage(trigger.exitPriceRaw, pos.direction, 'exit', slippagePercent);
  return {
    exitReason: trigger.exitReason,
    exitPriceRaw: trigger.exitPriceRaw,
    exitPrice,
    ...computeTradePnl({
      direction: pos.direction,
      entryPrice: pos.entryPrice,
      entryMarkPrice: pos.entryMarkPrice ?? pos.entryPrice,
      exitPrice,
      exitPriceRaw: trigger.exitPriceRaw,
      quantity: pos.quantity,
      feePercent,
      riskUsdt: pos.riskUsdt,
      marginUsdt: pos.marginUsdt,
    }),
  };
}
