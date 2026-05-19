/**
 * Extreme Order Block (OB) Detection
 *
 * An Extreme Order Block is the last bearish candle before a strong bullish impulse (for LONG),
 * or the last bullish candle before a strong bearish impulse (for SHORT).
 *
 * "Extreme" qualifier: the impulse move must break a prior swing high/low (market structure break),
 * AND the OB candle must have above-average volume.
 *
 * OB Zone:
 *   LONG OB: high and low of the last bearish candle before the bullish impulse
 *   SHORT OB: high and low of the last bullish candle before the bearish impulse
 *
 * Entry logic:
 *   Price returns to OB zone AND is near 79% Fibonacci retracement → entry signal
 */

/**
 * Detect Extreme Order Blocks in a kline array.
 *
 * @param {Array} klines - sorted oldest first
 * @param {number} impulseMinPct - minimum % move to qualify as impulse (default 0.8%)
 * @param {number} lookback - how many candles back to search for OBs
 * @param {number} volumeMultiplier - OB candle volume must be >= N × avg volume
 * @returns {Array<{ direction: 'LONG'|'SHORT', obHigh: number, obLow: number, obIndex: number, impulseSize: number, time: number }>}
 */
export function detectOrderBlocks(klines, impulseMinPct = 0.8, lookback = 30, volumeMultiplier = 1.2) {
  const orderBlocks = [];
  const start = Math.max(2, klines.length - lookback);

  // Average volume for the lookback window
  const avgVol = klines.slice(start, klines.length - 1)
    .reduce((s, k) => s + k.volume, 0) / Math.max(1, klines.length - start - 1);

  for (let i = start; i < klines.length - 1; i++) {
    const candle = klines[i];
    const next   = klines[i + 1];

    const isBearishCandle = candle.close < candle.open;
    const isBullishCandle = candle.close > candle.open;

    // LONG OB: bearish candle followed by strong bullish impulse
    if (isBearishCandle) {
      const impulse = (next.close - next.open) / next.open * 100;
      if (impulse >= impulseMinPct && candle.volume >= avgVol * volumeMultiplier) {
        orderBlocks.push({
          direction: 'LONG',
          obHigh: candle.high,
          obLow:  candle.low,
          obMid:  (candle.high + candle.low) / 2,
          obIndex: i,
          impulseSize: impulse,
          time: candle.openTime,
        });
      }
    }

    // SHORT OB: bullish candle followed by strong bearish impulse
    if (isBullishCandle) {
      const impulse = (next.open - next.close) / next.open * 100;
      if (impulse >= impulseMinPct && candle.volume >= avgVol * volumeMultiplier) {
        orderBlocks.push({
          direction: 'SHORT',
          obHigh: candle.high,
          obLow:  candle.low,
          obMid:  (candle.high + candle.low) / 2,
          obIndex: i,
          impulseSize: impulse,
          time: candle.openTime,
        });
      }
    }
  }

  return orderBlocks;
}

/**
 * Check if current price is inside or touching an Order Block zone.
 *
 * @param {number} currentPrice
 * @param {{ obHigh: number, obLow: number, direction: string }} ob
 * @param {number} tolerance - % buffer (default 0.3%)
 * @returns {boolean}
 */
export function isPriceInOrderBlock(currentPrice, ob, tolerance = 0.003) {
  const buffer = (ob.obHigh - ob.obLow) * tolerance;
  return currentPrice >= (ob.obLow - buffer) && currentPrice <= (ob.obHigh + buffer);
}

/**
 * Find the most recent valid Extreme Order Block that:
 * 1. Matches the given direction
 * 2. Has NOT been fully violated (price hasn't closed through the OB)
 * 3. Is the closest OB to current price
 *
 * @param {Array} klines
 * @param {'LONG'|'SHORT'} direction
 * @param {number} currentPrice
 * @returns {object|null}
 */
export function findRelevantOrderBlock(klines, direction, currentPrice) {
  const obs = detectOrderBlocks(klines).filter(ob => ob.direction === direction);
  if (!obs.length) return null;

  // Filter out OBs that have been violated (price closed beyond OB)
  const valid = obs.filter(ob => {
    const subsequentKlines = klines.slice(ob.obIndex + 1);
    if (direction === 'LONG') {
      // OB violated if any subsequent candle closed below OB low
      return !subsequentKlines.some(k => k.close < ob.obLow);
    } else {
      // OB violated if any subsequent candle closed above OB high
      return !subsequentKlines.some(k => k.close > ob.obHigh);
    }
  });

  if (!valid.length) return null;

  // Return the most recent valid OB
  return valid[valid.length - 1];
}
