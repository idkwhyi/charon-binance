/** Index of the first candle with openTime >= tMs (candles sorted by openTime). */
export function lowerBoundByOpenTime(candles, tMs) {
  let lo = 0, hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].openTime < tMs) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** 1m candles that opened in [fromMs, toMs). */
export function candlesBetween(candles, fromMs, toMs) {
  return candles.slice(lowerBoundByOpenTime(candles, fromMs), lowerBoundByOpenTime(candles, toMs));
}

/** Close of the latest 1m candle that closed before tMs (stand-in for mark price). */
export function lastClosedPrice(candles, tMs) {
  for (let i = lowerBoundByOpenTime(candles, tMs) - 1; i >= 0; i--) {
    if (candles[i].closeTime < tMs) return candles[i].close;
  }
  return null;
}
