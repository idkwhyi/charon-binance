/**
 * Portfolio-level entry decisions for one scan cycle (pure). Used by the
 * live/dry-run orchestrator AND the backtest so both apply identical rules.
 */

import { rankCandidates } from './candidateSelector.js';
import { directionCounts } from './riskControls.js';

/**
 * Should the whole cycle be blocked? Checked in this order; omitted inputs
 * are skipped.
 * @param {object} p
 * @param {boolean} [p.paused] - /pause
 * @param {{ breached: boolean, pnlPercent: number }} [p.daily] - dailyLossStatus()
 * @param {number} [p.dailyLimitPercent]
 * @param {number} [p.openCount] - currently open positions
 * @param {number} [p.maxOpenPositions] - strategy max_open_positions
 * @returns {{ code: string, reason: string }|null}
 */
export function portfolioBlock({ paused = false, daily = null, dailyLimitPercent = null, openCount = null, maxOpenPositions = null }) {
  if (paused) return { code: 'entries_paused', reason: 'entries paused (/pause)' };
  if (daily?.breached) {
    return { code: 'daily_loss_limit', reason: `daily loss limit hit (${daily.pnlPercent.toFixed(2)}% <= -${dailyLimitPercent}%), resumes 00:00 UTC` };
  }
  if (openCount !== null && maxOpenPositions !== null && openCount >= maxOpenPositions) {
    return { code: 'max_positions', reason: `max open positions (${maxOpenPositions}) reached` };
  }
  return null;
}

/**
 * Pick at most ONE entry for the cycle: rank by confirmation score → R:R →
 * 24h volume → symbol, skipping symbols with an open position and
 * directions at their cap.
 * @param {Array<object>} candidates - filtered candidates of this cycle
 * @param {Array<{symbol: string, direction: string}>} openPositions
 * @param {number} maxSameDirection
 * @returns {{ selected: object|null, rejections: Array<{ candidate: object, reasonCode: string, reason: string }>, blockedDirections: string[] }}
 */
export function pickCycleEntry(candidates, openPositions, maxSameDirection) {
  const openSymbols = new Set(openPositions.map(p => p.symbol));
  const counts = directionCounts(openPositions);
  const blockedDirections = ['LONG', 'SHORT'].filter(d => maxSameDirection > 0 && counts[d] >= maxSameDirection);
  const selected = rankCandidates(candidates, openSymbols, blockedDirections)[0] || null;

  const rejections = candidates
    .filter(c => c !== selected)
    .map(c => {
      if (openSymbols.has(c.symbol)) return { candidate: c, reasonCode: 'symbol_open', reason: 'symbol already has an open position' };
      if (blockedDirections.includes(c.direction)) {
        return { candidate: c, reasonCode: 'direction_cap', reason: `already ${maxSameDirection} open ${c.direction} position(s)` };
      }
      return { candidate: c, reasonCode: 'not_selected', reason: `ranked below ${selected?.symbol} (score / R:R / volume)` };
    });

  return { selected, rejections, blockedDirections };
}
