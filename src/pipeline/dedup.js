const CANDLE_15M_MS = 15 * 60_000;

/**
 * Dedup key for a raw signal: one setup (symbol + direction) is processed at
 * most once per 15m candle. Uses the close time of the latest 15m candle the
 * signal was computed on; falls back to the 15m bucket of detectedAt.
 */
export function signalDedupKey(rawSignal) {
  const klines = rawSignal.klines15m || [];
  const candleCloseTime = klines[klines.length - 1]?.closeTime
    ?? Math.floor(Number(rawSignal.detectedAt || 0) / CANDLE_15M_MS);
  return `${rawSignal.symbol}:${rawSignal.direction}:${candleCloseTime}`;
}

/** How long seen keys are kept — comfortably longer than one candle. */
export const DEDUP_TTL_MS = 2 * 60 * 60_000;
