/**
 * Extreme Order Block (OB) Detection
 *
 * An Order Block is the last opposing candle before a strong impulse move.
 *
 * LONG OB:  last bearish candle before a strong bullish impulse
 * SHORT OB: last bullish candle before a strong bearish impulse
 *
 * "Extreme" qualifier:
 *   - Impulse candle body >= impulseMinPct
 *   - OB candle volume >= volumeMultiplier × average volume (above-average participation)
 *
 * Validity rules:
 *   - OB is VALID as long as price has NOT fully closed THROUGH the OB zone
 *     (closing below OB low for LONG, closing above OB high for SHORT)
 *   - OB is still valid even if price has traded inside the zone (that's the entry!)
 *   - We look for the most recent OB that price is currently approaching or inside
 */

/**
 * Detect all Order Blocks in a kline array.
 *
 * @param {Array}  klines           - sorted oldest first
 * @param {number} impulseMinPct    - min body % of impulse candle (default 0.5%)
 * @param {number} lookback         - candles to look back (default 40)
 * @param {number} volumeMultiplier - OB candle volume >= N × avg (default 1.0, relaxed)
 */
export function detectOrderBlocks(klines, impulseMinPct = 0.5, lookback = 40, volumeMultiplier = 1.0) {
  const orderBlocks = [];
  const start = Math.max(2, klines.length - lookback);

  // Average volume over the lookback window
  const window = klines.slice(start, klines.length - 1);
  const avgVol = window.reduce((s, k) => s + k.volume, 0) / Math.max(1, window.length);

  for (let i = start; i < klines.length - 1; i++) {
    const ob   = klines[i];
    const next = klines[i + 1];

    const obBody   = Math.abs(ob.close - ob.open);
    const nextBody = Math.abs(next.close - next.open);
    const nextBodyPct = next.open > 0 ? (nextBody / next.open) * 100 : 0;

    const isBearish = ob.close < ob.open;
    const isBullish = ob.close > ob.open;

    // LONG OB: bearish candle → strong bullish impulse next
    if (isBearish && next.close > next.open) {
      if (nextBodyPct >= impulseMinPct && ob.volume >= avgVol * volumeMultiplier) {
        orderBlocks.push({
          direction:   'LONG',
          obHigh:      ob.high,
          obLow:       ob.low,
          obOpen:      ob.open,
          obClose:     ob.close,
          obMid:       (ob.high + ob.low) / 2,
          obIndex:     i,
          impulseSize: nextBodyPct,
          volume:      ob.volume,
          avgVol,
          time:        ob.openTime,
        });
      }
    }

    // SHORT OB: bullish candle → strong bearish impulse next
    if (isBullish && next.close < next.open) {
      if (nextBodyPct >= impulseMinPct && ob.volume >= avgVol * volumeMultiplier) {
        orderBlocks.push({
          direction:   'SHORT',
          obHigh:      ob.high,
          obLow:       ob.low,
          obOpen:      ob.open,
          obClose:     ob.close,
          obMid:       (ob.high + ob.low) / 2,
          obIndex:     i,
          impulseSize: nextBodyPct,
          volume:      ob.volume,
          avgVol,
          time:        ob.openTime,
        });
      }
    }
  }

  return orderBlocks;
}

/**
 * Check if current price is inside or near an Order Block zone.
 *
 * @param {number} currentPrice
 * @param {object} ob
 * @param {number} tolerance - extra buffer as fraction of OB range (default 0.5)
 */
export function isPriceInOrderBlock(currentPrice, ob, tolerance = 0.5) {
  const range  = ob.obHigh - ob.obLow;
  const buffer = range * tolerance;
  return currentPrice >= (ob.obLow - buffer) && currentPrice <= (ob.obHigh + buffer);
}

/**
 * Find the most relevant Order Block for the given direction.
 *
 * Rules:
 * 1. Must match direction
 * 2. Must NOT be fully violated:
 *    - LONG OB violated = any subsequent candle CLOSED below OB low
 *    - SHORT OB violated = any subsequent candle CLOSED above OB high
 * 3. Price must be AT or BELOW the OB zone (approaching from above for LONG retrace)
 *    or AT or ABOVE the OB zone (approaching from below for SHORT retrace)
 * 4. Among valid OBs, return the most recent one (closest to current price action)
 *
 * @param {Array}  klines
 * @param {'LONG'|'SHORT'} direction
 * @param {number} currentPrice
 */
export function findRelevantOrderBlock(klines, direction, currentPrice) {
  const allOBs = detectOrderBlocks(klines).filter(ob => ob.direction === direction);

  if (!allOBs.length) return null;

  const valid = allOBs.filter(ob => {
    const subsequent = klines.slice(ob.obIndex + 2); // skip the impulse candle itself

    if (direction === 'LONG') {
      // Violated if any candle CLOSED below OB low (structure broken)
      const violated = subsequent.some(k => k.close < ob.obLow);
      if (violated) return false;

      // Price must be at or below OB high (retracing into zone)
      // Allow price to be up to 2× OB range above OB high (approaching)
      const range = ob.obHigh - ob.obLow;
      return currentPrice <= ob.obHigh + range * 2;

    } else {
      // Violated if any candle CLOSED above OB high (structure broken)
      const violated = subsequent.some(k => k.close > ob.obHigh);
      if (violated) return false;

      // Price must be at or above OB low (retracing into zone)
      const range = ob.obHigh - ob.obLow;
      return currentPrice >= ob.obLow - range * 2;
    }
  });

  if (!valid.length) return null;

  // Return the most recent valid OB
  return valid[valid.length - 1];
}
