/**
 * Extreme Order Block Signal Detector
 *
 * Full pipeline:
 * 1. Detect Market Structure on 15m → determine trend direction
 * 2. Find Extreme Order Block matching the trend direction on 5m
 * 3. Calculate Fibonacci retracement of the last swing move
 * 4. Check if current price is at 79% fib retracement AND inside/near the OB zone
 * 5. SL below Higher Low (LONG) or above Lower High (SHORT)
 * 6. TP at previous swing high/low
 * 7. Require minimum R:R of 1.8
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

/**
 * Run the Extreme OB strategy check on 15m klines.
 * Market structure, OB detection, and Fibonacci all use the same 15m timeframe.
 *
 * @param {Array} klines15m - 15m klines, sorted oldest first
 * @param {number|null} fundingRate
 * @returns {Array<{ type: string, direction: 'LONG'|'SHORT', meta: object }>}
 */
export function detectExtremeOB(klines15m, fundingRate = null) {
  const signals = [];

  if (!klines15m || klines15m.length < 20) return signals;

  // entry = close of the latest 15m candle
  const entry = klines15m[klines15m.length - 1].close;

  // ── Step 1: Market Structure ──────────────────────────────────────────────
  const ms = detectMarketStructure(klines15m, 3, 3);
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

  // ── Step 2: Find Extreme Order Block (15m) ────────────────────────────────
  const ob = findRelevantOrderBlock(klines15m, direction, entry);
  if (!ob) {
    console.log(`[ob] skip ${sym}: no valid OB found`);
    return signals;
  }

  // ── Step 3: Fibonacci Retracement ────────────────────────────────────────
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

  // ── Step 7: R:R Validation ────────────────────────────────────────────────
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

  console.log(`[ob] SIGNAL ${sym}: ${direction} R:R=${rrRatio.toFixed(2)} entry=${entry} sl=${stopLoss} tp=${takeProfit} (IN OB ZONE)`);
  signals.push({ type: SIGNAL_TYPE, direction, meta });

  return signals;
}
