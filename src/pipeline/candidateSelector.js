/**
 * Deterministic candidate selection — replaces the LLM's role as "pick at most
 * one candidate per cycle" when LLM decisions are disabled.
 *
 * Ranking: entry-confirmation score (desc) → R:R (desc) → 24h volume (desc),
 * with symbol (asc) as a final tie-break so the same inputs always yield the
 * same pick. Symbols that already have an open position are skipped.
 */

function confirmationScore(c) {
  return Number(c.signals?.meta?.entryConfirmation?.score) || 0;
}

function rrRatio(c) {
  return Number(c.obRR ?? c.signals?.meta?.rrRatio) || 0;
}

function volume24h(c) {
  return Number(c.metrics?.volume24hUsdt) || 0;
}

export function compareCandidates(a, b) {
  return (confirmationScore(b) - confirmationScore(a))
    || (rrRatio(b) - rrRatio(a))
    || (volume24h(b) - volume24h(a))
    || String(a.symbol).localeCompare(String(b.symbol));
}

/**
 * Rank candidates and drop those whose symbol already has an open position.
 * @param {Array<object>} candidates - candidates that passed filters
 * @param {Set<string>|Array<string>} openSymbols - symbols with an open position
 * @returns {Array<object>} eligible candidates, best first
 */
export function rankCandidates(candidates, openSymbols = new Set()) {
  const open = openSymbols instanceof Set ? openSymbols : new Set(openSymbols);
  return candidates
    .filter(c => !open.has(c.symbol))
    .sort(compareCandidates);
}

/**
 * @returns {object|null} the single best eligible candidate, or null
 */
export function selectCandidate(candidates, openSymbols = new Set()) {
  return rankCandidates(candidates, openSymbols)[0] || null;
}

/**
 * LLM decides only when explicitly enabled globally AND by the strategy.
 * @param {boolean} llmDecisionEnabled - LLM_DECISION_ENABLED config flag
 * @param {object} strat - active strategy
 */
export function shouldUseLlm(llmDecisionEnabled, strat) {
  return Boolean(llmDecisionEnabled && strat?.use_llm);
}
