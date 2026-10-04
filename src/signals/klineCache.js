/**
 * Closed-candle-only kline handling (pure). Signals must never be computed
 * from a candle that is still forming.
 *
 * Binance sets closeTime = openTime + interval - 1, so a candle is closed
 * once closeTime < now. The REST /klines endpoint always returns the forming
 * candle as its last element; the WebSocket stream sends it repeatedly with
 * k.x = false until it closes.
 */

/** Keep only candles that have closed by nowMs. */
export function closedOnly(klines, nowMs = Date.now()) {
  return (klines || []).filter(k => k.closeTime < nowMs);
}

/**
 * Insert or replace a candle by openTime, keeping the array sorted and at
 * most `max` long. A closed version replaces any earlier copy instead of
 * being appended next to it.
 * @returns {Array} a new array
 */
export function mergeCandle(klines, candle, max = 100) {
  const out = (klines || []).filter(k => k.openTime !== candle.openTime);
  out.push(candle);
  out.sort((a, b) => a.openTime - b.openTime);
  return out.length > max ? out.slice(out.length - max) : out;
}

/**
 * Parse a combined-stream kline message. Returns null for anything that is
 * not a closed kline.
 * @returns {{ symbol: string, interval: string, candle: object }|null}
 */
export function parseClosedKlineMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return null; }
  const data = msg?.data;
  if (!data || data.e !== 'kline') return null;
  const k = data.k;
  if (!k?.x) return null; // still forming
  return {
    symbol: k.s,
    interval: k.i,
    candle: {
      openTime:    k.t,
      open:        Number(k.o),
      high:        Number(k.h),
      low:         Number(k.l),
      close:       Number(k.c),
      volume:      Number(k.v),
      closeTime:   k.T,
      quoteVolume: Number(k.q),
    },
  };
}

export const INTERVAL_MS = { '1m': 60_000, '15m': 15 * 60_000, '1h': 60 * 60_000 };

/** openTime of the most recent candle that has closed by nowMs. */
export function latestClosedOpenTime(intervalMs, nowMs) {
  return Math.floor(nowMs / intervalMs) * intervalMs - intervalMs;
}

/**
 * Missing candles in a closed-candle series, as spans of missing openTimes.
 * Checks gaps between consecutive candles and, if nowMs is given, a tail gap
 * (the latest closed candle(s) not in the series yet).
 * @returns {Array<{ afterOpenTime: number, fromOpenTime: number, toOpenTime: number, count: number }>}
 *   afterOpenTime = openTime of the last candle present before the hole
 */
export function findGaps(klines, intervalMs, nowMs = null) {
  const gaps = [];
  for (let i = 1; i < klines.length; i++) {
    const prev = klines[i - 1].openTime;
    const cur = klines[i].openTime;
    if (cur - prev > intervalMs) {
      gaps.push({ afterOpenTime: prev, fromOpenTime: prev + intervalMs, toOpenTime: cur - intervalMs, count: (cur - prev) / intervalMs - 1 });
    }
  }
  if (nowMs !== null && klines.length) {
    const last = klines[klines.length - 1].openTime;
    const expected = latestClosedOpenTime(intervalMs, nowMs);
    if (expected > last) {
      gaps.push({ afterOpenTime: last, fromOpenTime: last + intervalMs, toOpenTime: expected, count: (expected - last) / intervalMs });
    }
  }
  return gaps;
}
