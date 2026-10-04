/**
 * Risk-based position sizing, shared by the live/dry-run pipeline
 * (candidateBuilder.js) and the backtest engine (backtest/runner.js).
 *
 * The dollar amount at risk is fixed as a % of current available balance,
 * independent of leverage: riskUsdt = availableBalanceUsdt * riskPercent / 100.
 * The notional (and therefore the margin locked) is derived from the trade's
 * actual SL distance, so a tight stop gets a bigger notional and a wide stop
 * gets a smaller one — dollar risk stays constant either way:
 *
 *   notionalUsdt = riskUsdt / (slDistancePercent / 100)
 *   entryUsdt    = notionalUsdt / leverage
 *
 * Leverage does not change how much is risked — it only exists to keep the
 * margin locked for that notional affordable (some symbols need more
 * notional than others to satisfy exchange minimum order size).
 *
 * If the target risk% would require more margin than maxMarginPercent allows
 * (e.g. a very tight SL), the margin is clamped to the cap instead of
 * rejecting the trade outright — the trade still fires, just risking less
 * than riskPercent of balance. This matches leverage's role above: the cap
 * exists to keep margin affordable, not to veto otherwise-valid setups.
 *
 * @param {object} params
 * @param {number} params.availableBalanceUsdt - current available balance/equity
 * @param {number} params.riskPercent - % of balance to risk on this trade
 * @param {number} params.slDistancePercent - absolute % distance from entry to SL
 * @param {number} params.leverage
 * @param {number} params.maxMarginPercent - safety cap: clamp margin to this % of balance instead of exceeding it
 * @returns {{ entryUsdt: number, notionalUsdt: number, riskUsdt: number, clamped: boolean, ok: boolean, reason: string|null }}
 */
export function calculatePositionSize({ availableBalanceUsdt, riskPercent, slDistancePercent, leverage, maxMarginPercent }) {
  if (!(availableBalanceUsdt > 0) || !(slDistancePercent > 0) || !(leverage > 0)) {
    return { entryUsdt: 0, notionalUsdt: 0, riskUsdt: 0, clamped: false, ok: false, reason: 'invalid sizing inputs (balance/SL distance/leverage)' };
  }

  const targetRiskUsdt = availableBalanceUsdt * (riskPercent / 100);
  const targetNotionalUsdt = targetRiskUsdt / (slDistancePercent / 100);
  const targetEntryUsdt = targetNotionalUsdt / leverage;
  const maxMarginUsdt = availableBalanceUsdt * (maxMarginPercent / 100);

  if (targetEntryUsdt > maxMarginUsdt) {
    // Clamp margin to the cap; actual risk taken is smaller than riskPercent.
    const entryUsdt = maxMarginUsdt;
    const notionalUsdt = entryUsdt * leverage;
    const riskUsdt = notionalUsdt * (slDistancePercent / 100);
    return {
      entryUsdt, notionalUsdt, riskUsdt, clamped: true, ok: true,
      reason: `margin clamped to cap $${maxMarginUsdt.toFixed(2)} (${maxMarginPercent}% of balance) — SL ${slDistancePercent.toFixed(2)}% too tight for ${leverage}x to hit ${riskPercent}% target risk; actual risk ~$${riskUsdt.toFixed(2)}`,
    };
  }

  return { entryUsdt: targetEntryUsdt, notionalUsdt: targetNotionalUsdt, riskUsdt: targetRiskUsdt, clamped: false, ok: true, reason: null };
}
