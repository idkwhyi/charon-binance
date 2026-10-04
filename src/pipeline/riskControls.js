/**
 * Portfolio-level risk gates (pure). Wired in src/pipeline/orchestrator.js.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 00:00 UTC (07:00 WIB) of the day containing nowMs. */
export function utcDayStartMs(nowMs) {
  return Math.floor(nowMs / DAY_MS) * DAY_MS;
}

/**
 * Daily loss limit: breached once today's realized PnL is at or below
 * -limitPercent of the balance at the start of the UTC day.
 * @param {number} currentBalanceUsdt - realized balance now
 * @param {number} realizedTodayUsdt - PnL of positions closed since 00:00 UTC
 * @param {number} limitPercent - e.g. 3 for -3%
 */
export function dailyLossStatus({ currentBalanceUsdt, realizedTodayUsdt, limitPercent }) {
  const startOfDayBalanceUsdt = currentBalanceUsdt - realizedTodayUsdt;
  const pnlPercent = startOfDayBalanceUsdt > 0 ? realizedTodayUsdt / startOfDayBalanceUsdt * 100 : 0;
  return {
    breached: limitPercent > 0 && pnlPercent <= -Math.abs(limitPercent),
    pnlPercent,
    startOfDayBalanceUsdt,
  };
}

/** Count open positions per direction. */
export function directionCounts(positions) {
  const counts = { LONG: 0, SHORT: 0 };
  for (const p of positions) if (p.direction in counts) counts[p.direction]++;
  return counts;
}

/** True if another position in `direction` would exceed `maxSameDirection`. */
export function directionCapReached(positions, direction, maxSameDirection) {
  return maxSameDirection > 0 && directionCounts(positions)[direction] >= maxSameDirection;
}
