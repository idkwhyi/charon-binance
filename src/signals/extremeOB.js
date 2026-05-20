/**
 * Extreme Order Block Signal Detector
 *
 * Multi-Timeframe Pipeline:
 * 1. Detect Market Structure on 1H → determine trend direction (larger swings)
 * 2. Find Extreme Order Block matching the trend direction on 1H (institutional zones)
 * 3. Calculate Fibonacci retracement of the last swing move on 1H
 * 4. Check if current price (15m) is at 79% fib retracement AND inside/near the OB zone
 * 5. SL below Higher Low (LONG) or above Lower High (SHORT) from 1H structure
 * 6. TP at previous swing high/low from 1H
 * 7. Require minimum R:R of 1.8
 * 8. Require minimum distance for SL (0.5%) and TP (1.0%) to avoid noise
 *
 * Also emits 'extreme_ob_watch' signals for near-miss candidates
 * (valid OB + structure, but price not yet in zone) for Telegram alerts.
 */

import { detectMarketStructure } from './marketStructure.js';
import { isPriceInFibZone, calcFibLevels } from './fibonacci.js';
import { findRelevantOrderBlock, isPriceInOrderBlock } from './orderBlock.js';

const SIGNAL_TYPE       = 'extreme_ob';
const SIGNAL_TYPE_WATCH = 'extreme_ob_watch'; // near-miss, not yet in zone
const MIN_RR = 1.8;
const MIN_SL_DISTANCE_PCT = 0.5;  // minimum 0.5% SL distance
const MIN_TP_DISTANCE_PCT = 1.0;  // minimum 1.0% TP distance

/**
 * Run the Extreme OB strategy check using multi-timeframe analysis.
 * - 1H klines: Market structure, OB detection, and Fibonacci (larger swings)
 * - 15m klines: Entry timing (current price for precision)
 *
 * @param {Array} klines1h - 1h klines, sorted oldest first
 * @param {Array} klines15m - 15m klines, sorted oldest first
 * @param {number|null} fundingRate
 * @returns {Array<{ type: string, direction: 'LONG'|'SHORT', meta: object }>}
 */
export function detectExtremeOB(klines1h, klines15m, fundingRate = null) {
  const signals = [];

  if (!klines1h || klines1h.length < 20) return signals;
  if (!klines15m || klines15m.length < 5) return signals;

  // Entry = close of the latest 15m candle (precise entry timing)
  const entry = klines15m[klines15m.length - 1].close;

  // ── Step 1: Market Structure (1H for larger swings) ──────────────────────
  const ms = detectMarketStructure(klines1h, 5, 5); // Increased from 3,3 to 5,5 for more significant swings
  if (ms.trend === 'RANGING') return signals;

  const direction = ms.trend === 'UPTREND' ? 'LONG' : 'SHORT';
  const sym = `price=${entry} trend=${ms.trend}`;

  // Funding rate bias filter
  if (fundingRate !== null) {
    const fr = Number(fundingRate);
    if (direction === 'LONG'  && fr >  0.002) {
      console.log(`[ob] skip ${sym}: funding too high for LONG (${fr})`);
      return signals;
    }
    if (direction === 'SHORT' && fr < -0.001) {
      console.log(`[ob] skip ${sym}: funding too low for SHORT (${fr})`);
      return signals;
    }
  }

  // ── Step 2: Find Extreme Order Block (1H for institutional zones) ────────
  const ob = findRelevantOrderBlock(klines1h, direction, entry);
  if (!ob) {
    console.log(`[ob] skip ${sym}: no valid OB found`);
    return signals;
  }

  // ── Step 3: Fibonacci Retracement (1H swings) ────────────────────────────
  const { swingHighs, swingLows } = ms;
  if (swingHighs.length < 1 || swingLows.length < 1) {
    console.log(`[ob] skip ${sym}: not enough swing points`);
    return signals;
  }

  const lastSwingHigh = swingHighs[swingHighs.length - 1].price;
  const lastSwingLow  = swingLows[swingLows.length - 1].price;
  const fibResult     = isPriceInFibZone(entry, lastSwingLow, lastSwingHigh, direction);
  const { levels }    = calcFibLevels(lastSwingLow, lastSwingHigh, direction);

  // ── Step 4: Entry Condition ───────────────────────────────────────────────
  const inFibZone = fibResult.inZone;
  const inOBZone  = isPriceInOrderBlock(entry, ob);

  // ── Step 5: SL Placement ─────────────────────────────────────────────────
  let stopLoss, slAnchorLabel, slAnchorPrice;

  if (direction === 'LONG') {
    const higherLow = ms.lastHL ?? lastSwingLow;
    if (higherLow >= entry) {
      console.log(`[ob] skip ${sym}: HL ${higherLow.toFixed(6)} >= entry ${entry.toFixed(6)} (invalid anchor)`);
      return signals;
    }
    const buffer  = higherLow * 0.003;
    stopLoss      = parseFloat((higherLow - buffer).toFixed(8));
    slAnchorLabel = 'Higher Low';
    slAnchorPrice = higherLow;
  } else {
    const lowerHigh = ms.lastLH ?? lastSwingHigh;
    if (lowerHigh <= entry) {
      console.log(`[ob] skip ${sym}: LH ${lowerHigh.toFixed(6)} <= entry ${entry.toFixed(6)} (invalid anchor)`);
      return signals;
    }
    const buffer  = lowerHigh * 0.003;
    stopLoss      = parseFloat((lowerHigh + buffer).toFixed(8));
    slAnchorLabel = 'Lower High';
    slAnchorPrice = lowerHigh;
  }

  // ── Step 6: Take Profit ───────────────────────────────────────────────────
  const takeProfit = direction === 'LONG' ? lastSwingHigh : lastSwingLow;

  // ── Step 7: Distance Validation (avoid noise) ─────────────────────────────
  const slDistancePct = Math.abs((stopLoss - entry) / entry * 100);
  const tpDistancePct = Math.abs((takeProfit - entry) / entry * 100);

  if (slDistancePct < MIN_SL_DISTANCE_PCT) {
    console.log(`[ob] skip ${sym}: SL too close (${slDistancePct.toFixed(2)}% < ${MIN_SL_DISTANCE_PCT}%)`);
    return signals;
  }

  if (tpDistancePct < MIN_TP_DISTANCE_PCT) {
    console.log(`[ob] skip ${sym}: TP too close (${tpDistancePct.toFixed(2)}% < ${MIN_TP_DISTANCE_PCT}%)`);
    return signals;
  }

  // ── Step 8: R:R Validation ────────────────────────────────────────────────
  const risk   = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);

  if (direction === 'LONG'  && stopLoss >= entry) {
    console.log(`[ob] skip ${sym}: SL ${stopLoss.toFixed(6)} >= entry (invalid LONG SL)`);
    return signals;
  }
  if (direction === 'SHORT' && stopLoss <= entry) {
    console.log(`[ob] skip ${sym}: SL ${stopLoss.toFixed(6)} <= entry (invalid SHORT SL)`);
    return signals;
  }
  if (direction === 'LONG'  && takeProfit <= entry) {
    console.log(`[ob] skip ${sym}: TP ${takeProfit.toFixed(6)} <= entry (invalid LONG TP)`);
    return signals;
  }
  if (direction === 'SHORT' && takeProfit >= entry) {
    console.log(`[ob] skip ${sym}: TP ${takeProfit.toFixed(6)} >= entry (invalid SHORT TP)`);
    return signals;
  }

  const rrRatio    = risk > 0 ? reward / risk : 0;
  const tpPercent  = ((takeProfit - entry) / entry * 100) * (direction === 'LONG' ? 1 : -1);
  const slPercent  = ((stopLoss   - entry) / entry * 100) * (direction === 'LONG' ? 1 : -1);

  // Build shared meta object
  const meta = {
    timeframe:     '1H structure + 15m entry',
    trend:         ms.trend,
    lastSwingHigh,
    lastSwingLow,
    lastHH:        ms.lastHH,
    lastHL:        ms.lastHL,
    lastLL:        ms.lastLL,
    lastLH:        ms.lastLH,
    slAnchorLabel,
    slAnchorPrice,
    obHigh:        ob.obHigh,
    obLow:         ob.obLow,
    obMid:         ob.obMid,
    obImpulseSize: ob.impulseSize,
    fib79Price:    fibResult.fib79Price,
    fib705Price:   levels[0.705],
    inFibZone,
    inOBZone,
    fibLevels: {
      '23.6%': levels[0.236],
      '38.2%': levels[0.382],
      '50.0%': levels[0.5],
      '61.8%': levels[0.618],
      '70.5%': levels[0.705],
      '78.6%': levels[0.786],
      '88.6%': levels[0.886],
    },
    entry,
    stopLoss,
    takeProfit,
    tpPercent:  parseFloat(tpPercent.toFixed(4)),
    slPercent:  parseFloat(slPercent.toFixed(4)),
    slDistancePct: parseFloat(slDistancePct.toFixed(2)),
    tpDistancePct: parseFloat(tpDistancePct.toFixed(2)),
    rrRatio:    parseFloat(rrRatio.toFixed(2)),
    minRR:      MIN_RR,
    fundingRate,
  };

  // ── Near-miss: valid setup but price not yet in OB zone ──────────────────
  // Entry ONLY when price is inside the Order Block zone.
  // Being in fib zone alone is not enough — we need price to retrace INTO the OB.
  if (!inOBZone) {
    if (rrRatio >= MIN_RR) {
      const distToOB = direction === 'LONG'
        ? ((ob.obHigh - entry) / entry * 100).toFixed(2)
        : ((entry - ob.obLow) / entry * 100).toFixed(2);
      console.log(`[ob] watch ${sym}: waiting for retrace to OB (${ob.obLow?.toFixed(6)}-${ob.obHigh?.toFixed(6)}, dist=${distToOB}%)`);
      signals.push({ type: SIGNAL_TYPE_WATCH, direction, meta: { ...meta, isWatch: true } });
    } else {
      console.log(`[ob] skip ${sym}: not in OB zone and R:R ${rrRatio.toFixed(2)} < ${MIN_RR}`);
    }
    return signals;
  }

  // ── Full signal: price inside OB zone + R:R valid ─────────────────────────
  if (rrRatio < MIN_RR) {
    console.log(`[ob] skip ${sym}: R:R ${rrRatio.toFixed(2)} < ${MIN_RR} | entry=${entry.toFixed(6)} sl=${stopLoss.toFixed(6)} tp=${takeProfit.toFixed(6)}`);
    return signals;
  }

  console.log(`[ob] SIGNAL ${sym}: ${direction} R:R=${rrRatio.toFixed(2)} entry=${entry} sl=${stopLoss} tp=${takeProfit} (1H structure, 15m entry, IN OB ZONE)`);
  signals.push({ type: SIGNAL_TYPE, direction, meta });

  return signals;
}
