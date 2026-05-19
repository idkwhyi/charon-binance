/**
 * Market Structure Analysis
 * Detects swing highs/lows and determines trend direction.
 * Used as prerequisite filter for Extreme Order Block strategy.
 */

/**
 * Find swing highs and lows using a pivot lookback window.
 * A swing high: candle[i].high is highest in window [i-left .. i+right]
 * A swing low:  candle[i].low  is lowest  in window [i-left .. i+right]
 *
 * @param {Array} klines - sorted oldest first
 * @param {number} left  - bars to the left
 * @param {number} right - bars to the right
 * @returns {{ swingHighs: Array, swingLows: Array }}
 */
export function findSwingPoints(klines, left = 3, right = 3) {
  const swingHighs = [];
  const swingLows = [];

  for (let i = left; i < klines.length - right; i++) {
    const window = klines.slice(i - left, i + right + 1);
    const pivot = klines[i];

    const isSwingHigh = window.every((k, idx) => idx === left || k.high <= pivot.high);
    const isSwingLow  = window.every((k, idx) => idx === left || k.low  >= pivot.low);

    if (isSwingHigh) swingHighs.push({ index: i, price: pivot.high, time: pivot.openTime });
    if (isSwingLow)  swingLows.push({ index: i, price: pivot.low,  time: pivot.openTime });
  }

  return { swingHighs, swingLows };
}

/**
 * Determine market structure trend from recent swing points.
 *
 * UPTREND:   last 2 swing highs are HH (Higher High) AND last 2 swing lows are HL (Higher Low)
 * DOWNTREND: last 2 swing lows are LL (Lower Low)   AND last 2 swing highs are LH (Lower High)
 * RANGING:   neither condition met
 *
 * @param {Array} klines
 * @param {number} left
 * @param {number} right
 * @returns {{ trend: 'UPTREND'|'DOWNTREND'|'RANGING', swingHighs: Array, swingLows: Array, lastHH: number|null, lastHL: number|null, lastLL: number|null, lastLH: number|null }}
 */
export function detectMarketStructure(klines, left = 3, right = 3) {
  const { swingHighs, swingLows } = findSwingPoints(klines, left, right);

  const result = {
    trend: 'RANGING',
    swingHighs,
    swingLows,
    lastHH: null,
    lastHL: null,
    lastLL: null,
    lastLH: null,
  };

  if (swingHighs.length < 2 || swingLows.length < 2) return result;

  const [prevHigh, lastHigh] = swingHighs.slice(-2);
  const [prevLow,  lastLow]  = swingLows.slice(-2);

  const isHH = lastHigh.price > prevHigh.price;
  const isHL = lastLow.price  > prevLow.price;
  const isLL = lastLow.price  < prevLow.price;
  const isLH = lastHigh.price < prevHigh.price;

  if (isHH && isHL) {
    result.trend  = 'UPTREND';
    result.lastHH = lastHigh.price;
    result.lastHL = lastLow.price;   // Higher Low — SL anchor for LONG
  } else if (isLL && isLH) {
    result.trend  = 'DOWNTREND';
    result.lastLL = lastLow.price;
    result.lastLH = lastHigh.price;  // Lower High — SL anchor for SHORT
  }

  return result;
}
