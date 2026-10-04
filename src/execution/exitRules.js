/**
 * Pure exit-rule helpers used by the position monitor (positions.js).
 * Kept free of DB/network imports so they can be unit-tested directly.
 */

/**
 * @param {object|null} strat - strategy (needs max_hold_ms)
 * @param {number|string} openedAtMs - pg returns BIGINT as string
 * @param {number} nowMs
 */
export function isMaxHoldHit(strat, openedAtMs, nowMs) {
  const maxHoldMs = Number(strat?.max_hold_ms);
  const openedAt = Number(openedAtMs);
  if (!(maxHoldMs > 0) || !(openedAt > 0)) return false;
  return nowMs - openedAt >= maxHoldMs;
}
