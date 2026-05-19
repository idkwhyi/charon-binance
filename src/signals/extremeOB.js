/**
 * Extreme Order Block Signal Detector
 *
 * Full pipeline:
 * 1. Detect Market Structure on 15m → determine trend direction
 * 2. Find Extreme Order Block matching the trend direction on 5m
 * 3. Calculate Fibonacci retracement of the last swing move
 * 4. Check if current price is at 79% fib retracement AND inside/near the OB zone
 * 5. Calculate SL based on market structure:
 *    - LONG:  SL below the last Higher Low (HL) with small buffer
 *    - SHORT: SL above the last Lower High (LH) with small buffer
 * 6. TP at previous swing high (LONG) or swing low (SHORT)
 * 7. Require minimum R:R of 1:2
 */

import { detectMarketStructure } from './marketStructure.js';
import { isPriceInFibZone, calcFibLevels } from './fibonacci.js';
import { findRelevantOrderBlock, isPriceInOrderBlock } from './orderBlock.js';

const SIGNAL_TYPE = 'extreme_ob';
const MIN_RR = 2.0; // minimum Risk:Reward ratio

/**
 * Run the Extreme OB strategy check.
 *
 * @param {Array} klines5m  - 5m klines, sorted oldest first (for OB detection)
 * @param {Array} klines15m - 15m klines, sorted oldest first (for market structure)
 * @param {number|null} fundingRate
 * @returns {Array<{ type: string, direction: 'LONG'|'SHORT', meta: object }>}
 */
export function detectExtremeOB(klines5m, klines15m, fundingRate = null) {
  const signals = [];

  if (!klines15m || klines15m.length < 20) return signals;
  if (!klines5m  || klines5m.length  < 20) return signals;

  const currentPrice = klines5m[klines5m.length - 1].close;

  // ── Step 1: Market Structure on 15m ──────────────────────────────────────
  const ms = detectMarketStructure(klines15m, 3, 3);

  if (ms.trend === 'RANGING') {
    return signals; // silent — most common case
  }

  const direction = ms.trend === 'UPTREND' ? 'LONG' : 'SHORT';
  const sym = `price=${currentPrice} trend=${ms.trend}`;

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

  // ── Step 2: Find Extreme Order Block on 5m ───────────────────────────────
  const ob = findRelevantOrderBlock(klines5m, direction, currentPrice);
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

  const fibResult = isPriceInFibZone(currentPrice, lastSwingLow, lastSwingHigh, direction);

  // ── Step 4: Entry Condition ───────────────────────────────────────────────
  const inFibZone = fibResult.inZone;
  const inOBZone  = isPriceInOrderBlock(currentPrice, ob);

  if (!inFibZone && !inOBZone) {
    console.log(`[ob] skip ${sym}: price not in fib zone (79%=${fibResult.fib79Price?.toFixed(4)}) nor OB zone (${ob.obLow?.toFixed(4)}-${ob.obHigh?.toFixed(4)})`);
    return signals;
  }

  // ── Step 5: SL Placement based on Market Structure ───────────────────────
  //
  // LONG  → SL below the last Higher Low (HL)
  //         The HL is the most recent swing low in an uptrend.
  //         We place SL just below it with a 0.3% buffer.
  //         If price breaks below HL, the uptrend is invalidated.
  //
  // SHORT → SL above the last Lower High (LH)
  //         The LH is the most recent swing high in a downtrend.
  //         We place SL just above it with a 0.3% buffer.
  //         If price breaks above LH, the downtrend is invalidated.

  let stopLoss;
  let slAnchorLabel;
  let slAnchorPrice;

  if (direction === 'LONG') {
    // Use the last Higher Low from market structure
    const higherLow = ms.lastHL ?? lastSwingLow;
    const buffer    = higherLow * 0.003; // 0.3% below HL
    stopLoss        = parseFloat((higherLow - buffer).toFixed(8));
    slAnchorLabel   = 'Higher Low';
    slAnchorPrice   = higherLow;
  } else {
    // Use the last Lower High from market structure
    const lowerHigh = ms.lastLH ?? lastSwingHigh;
    const buffer    = lowerHigh * 0.003; // 0.3% above LH
    stopLoss        = parseFloat((lowerHigh + buffer).toFixed(8));
    slAnchorLabel   = 'Lower High';
    slAnchorPrice   = lowerHigh;
  }

  // Entry: current price
  const entry = currentPrice;

  // ── Step 6: Take Profit ───────────────────────────────────────────────────
  // TP at the previous swing extreme (the HH for LONG, LL for SHORT)
  const takeProfit = direction === 'LONG' ? lastSwingHigh : lastSwingLow;

  // ── Step 7: R:R Validation ────────────────────────────────────────────────
  const risk   = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);

  // Guard: SL must be on the correct side of entry
  if (direction === 'LONG'  && stopLoss >= entry) {
    console.log(`[ob] skip ${sym}: SL ${stopLoss.toFixed(4)} >= entry ${entry.toFixed(4)} (invalid LONG SL)`);
    return signals;
  }
  if (direction === 'SHORT' && stopLoss <= entry) {
    console.log(`[ob] skip ${sym}: SL ${stopLoss.toFixed(4)} <= entry ${entry.toFixed(4)} (invalid SHORT SL)`);
    return signals;
  }

  // Guard: TP must be on the correct side of entry
  if (direction === 'LONG'  && takeProfit <= entry) {
    console.log(`[ob] skip ${sym}: TP ${takeProfit.toFixed(4)} <= entry ${entry.toFixed(4)} (invalid LONG TP)`);
    return signals;
  }
  if (direction === 'SHORT' && takeProfit >= entry) {
    console.log(`[ob] skip ${sym}: TP ${takeProfit.toFixed(4)} >= entry ${entry.toFixed(4)} (invalid SHORT TP)`);
    return signals;
  }

  const rrRatio = risk > 0 ? reward / risk : 0;

  // Require minimum 1:2 R:R
  if (rrRatio < MIN_RR) {
    console.log(`[ob] skip ${sym}: R:R ${rrRatio.toFixed(2)} < ${MIN_RR} | entry=${entry.toFixed(4)} sl=${stopLoss.toFixed(4)} tp=${takeProfit.toFixed(4)}`);
    return signals;
  }

  // Calculate TP/SL as percentages from entry (for executor compatibility)
  const tpPercent = ((takeProfit - entry) / entry * 100) * (direction === 'LONG' ? 1 : -1);
  const slPercent = ((stopLoss   - entry) / entry * 100) * (direction === 'LONG' ? 1 : -1);

  const { levels } = calcFibLevels(lastSwingLow, lastSwingHigh, direction);

  signals.push({
    type: SIGNAL_TYPE,
    direction,
    meta: {
      // Market structure
      trend:         ms.trend,
      lastSwingHigh,
      lastSwingLow,
      lastHH:        ms.lastHH,
      lastHL:        ms.lastHL,
      lastLL:        ms.lastLL,
      lastLH:        ms.lastLH,
      // SL anchor
      slAnchorLabel,
      slAnchorPrice,
      // Order block
      obHigh:        ob.obHigh,
      obLow:         ob.obLow,
      obMid:         ob.obMid,
      obImpulseSize: ob.impulseSize,
      // Fibonacci
      fib79Price:    fibResult.fib79Price,
      fib705Price:   fibResult.fib705Price,
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
      // Trade levels
      entry,
      stopLoss,
      takeProfit,
      tpPercent:  parseFloat(tpPercent.toFixed(4)),
      slPercent:  parseFloat(slPercent.toFixed(4)),
      rrRatio:    parseFloat(rrRatio.toFixed(2)),
      minRR:      MIN_RR,
      // Funding
      fundingRate,
    },
  });

  return signals;
}
