import { calculatePositionSize } from './positionSizing.js';
import { MIN_RR, MIN_SL_DISTANCE_PCT } from '../signals/extremeOB.js';
import { estimateLiqPrice } from '../execution/positionMath.js';

/**
 * Re-plan a trade at the price it will actually be entered at.
 *
 * The signal's R:R and SL distance are computed from optimalEntry (OB mid),
 * but the order fills at the current price. This recomputes R:R, SL distance
 * and risk-based sizing from the actual entry price and rejects the trade if
 * it no longer meets the rules.
 *
 * Structural levels (absolute stopLoss/takeProfit, e.g. extreme_ob) are
 * enforced against minRR / minSlDistancePct. Signals without them fall back
 * to percentage-based SL/TP around the entry, where only side/sizing checks apply.
 *
 * @returns {{ ok: boolean, code?: string, reason: string|null, entryPrice: number, stopLoss: number, takeProfit: number,
 *   rrRatio: number, liqPrice: number, slDistancePct: number, tpPercent: number, slPercent: number,
 *   entryUsdt: number, notionalUsdt: number, riskUsdt: number, clamped: boolean }}
 */
export function planEntry({
  direction,
  entryPrice,
  stopLoss = null,
  takeProfit = null,
  fallbackTpPercent = 2,
  fallbackSlPercent = -1.5,
  availableBalanceUsdt,
  riskPercent,
  leverage,
  maxMarginPercent,
  minRR = MIN_RR,
  minSlDistancePct = MIN_SL_DISTANCE_PCT,
}) {
  const isLong = direction === 'LONG';
  const reject = (code, reason, extra = {}) => ({ ok: false, code, reason, entryPrice, stopLoss, takeProfit, ...extra });

  if (!(entryPrice > 0)) return reject('price_unavailable', 'entry price missing');

  const structural = Number(stopLoss) > 0 && Number(takeProfit) > 0;
  if (!structural) {
    const tp = Math.abs(fallbackTpPercent) / 100;
    const sl = Math.abs(fallbackSlPercent) / 100;
    stopLoss = isLong ? entryPrice * (1 - sl) : entryPrice * (1 + sl);
    takeProfit = isLong ? entryPrice * (1 + tp) : entryPrice * (1 - tp);
  }
  stopLoss = Number(stopLoss);
  takeProfit = Number(takeProfit);

  if (isLong ? stopLoss >= entryPrice : stopLoss <= entryPrice) {
    return reject('beyond_sl', `price ${entryPrice} already beyond SL ${stopLoss}`);
  }
  if (isLong ? takeProfit <= entryPrice : takeProfit >= entryPrice) {
    return reject('beyond_tp', `price ${entryPrice} already beyond TP ${takeProfit}`);
  }

  const risk = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(takeProfit - entryPrice);
  const rrRatio = reward / risk;
  const slDistancePct = risk / entryPrice * 100;
  const tpPercent = reward / entryPrice * 100;
  const slPercent = -slDistancePct;
  const levels = { rrRatio, slDistancePct, tpPercent, slPercent };

  if (structural && rrRatio < minRR) {
    return reject('rr_at_entry', `R:R at actual entry ${rrRatio.toFixed(2)} < ${minRR}`, levels);
  }
  if (structural && slDistancePct < minSlDistancePct) {
    return reject('sl_distance_at_entry', `SL distance at actual entry ${slDistancePct.toFixed(2)}% < ${minSlDistancePct}%`, levels);
  }

  const liqPrice = estimateLiqPrice(entryPrice, direction, leverage);
  if (isLong ? stopLoss <= liqPrice : stopLoss >= liqPrice) {
    return reject('liq_too_close', `SL ${stopLoss} is not closer than estimated liquidation ${liqPrice.toFixed(8)} at ${leverage}x`, { ...levels, liqPrice });
  }

  const sizing = calculatePositionSize({ availableBalanceUsdt, riskPercent, slDistancePercent: slDistancePct, leverage, maxMarginPercent });
  if (!sizing.ok) return reject('sizing', `position sizing: ${sizing.reason}`, levels);

  return {
    ok: true, reason: null, entryPrice, stopLoss, takeProfit, ...levels, liqPrice,
    entryUsdt: sizing.entryUsdt, notionalUsdt: sizing.notionalUsdt, riskUsdt: sizing.riskUsdt, clamped: sizing.clamped,
  };
}
