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
