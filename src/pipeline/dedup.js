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

/** Shared seen-set: symbol:direction:candleCloseTime → first-seen ms. */
export const seenSignals = new Map();

function prune(nowMs) {
  for (const [k, t] of seenSignals) if (nowMs - t > DEDUP_TTL_MS) seenSignals.delete(k);
}

/**
 * Check-and-mark for a signal entering the pipeline.
 * @returns {boolean} true if this setup was already processed on this candle
 */
export function checkAndMarkSeen(rawSignal, nowMs = Date.now()) {
  prune(nowMs);
  const key = signalDedupKey(rawSignal);
  if (seenSignals.has(key)) return true;
  seenSignals.set(key, nowMs);
  return false;
}

/**
 * Detector outcomes for one setup on one candle:
 * - WATCH (waiting for OB zone / confirmation score) is NOT marked, so the
 *   setup can still become an entry on the same candle.
 * - Rejects by other rules (funding, R:R, structure, ...) ARE marked, so a
 *   condition that flips intra-candle (e.g. live funding) can't turn a
 *   rejected setup into an entry later in the same candle.
 * Rejects without a direction (ranging market) have no setup to mark.
 * @returns {boolean} whether the setup was marked
 */
export function markDetectorOutcome(symbol, signal, klines15m, nowMs = Date.now()) {
  if (signal.type !== 'extreme_ob_reject' || !signal.direction) return false;
  prune(nowMs);
  const key = signalDedupKey({ symbol, direction: signal.direction, klines15m });
  if (!seenSignals.has(key)) seenSignals.set(key, nowMs);
  return true;
}
