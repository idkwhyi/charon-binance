import { now, pruneSeen } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { upsertCandidate, updateCandidateStatus, recentEligibleCandidates, candidateById } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, createTradeIntent, updateTradeIntentStatus } from '../db/decisions.js';
import { buildCandidate, filterCandidate } from './candidateBuilder.js';
import { decideCandidateBatch } from './llm.js';
import { activeStrategy } from '../db/settings.js';
import { canOpenMorePositions, openPositionCount, openPositions, tradingMode, createDryRunPosition, createLivePosition } from '../db/positions.js';
import { sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { escapeHtml } from '../format.js';
import { executeFuturesBuy } from '../execution/futuresExecutor.js';
import { LLM_DECISION_ENABLED } from '../config.js';
import { rankCandidates, shouldUseLlm } from './candidateSelector.js';
import { signalDedupKey, DEDUP_TTL_MS } from './dedup.js';

export const seenSignals = new Map();

/**
 * Entry point for one scan cycle: receives every triggered signal at once.
 * - LLM decision path (only if LLM_DECISION_ENABLED and strategy use_llm):
 *   unchanged per-signal flow, the LLM picks among recent candidates.
 * - Rule-based path (default): build + filter every signal, then a
 *   deterministic selector opens at most ONE new entry for the whole cycle.
 */
export async function processScanCycle(rawSignals) {
  const strat = await activeStrategy();

  if (shouldUseLlm(LLM_DECISION_ENABLED, strat)) {
    for (const rawSignal of rawSignals) {
      await processSignalCandidate(rawSignal, strat).catch(err =>
        console.log(`[agent] ${rawSignal.symbol} failed: ${err.message}`));
    }
    return;
  }

  if (!await canOpenMorePositions(strat.max_open_positions || 3)) {
    console.log(`[agent] max positions (${strat.max_open_positions}) reached, skipping cycle of ${rawSignals.length} signal(s)`);
    return;
  }

  const prepared = [];
  for (const rawSignal of rawSignals) {
    const p = await prepareCandidate(rawSignal, strat).catch(err => {
      console.log(`[candidate] ${rawSignal.symbol} prepare failed: ${err.message}`);
      return null;
    });
    if (p) prepared.push(p);
  }
  if (prepared.length === 0) return;

  const openSymbols = new Set((await openPositions()).map(p => p.symbol));
  const ranked = rankCandidates(prepared.map(p => p.candidate), openSymbols);
  const selected = ranked[0];
  const skippedOpen = prepared.filter(p => openSymbols.has(p.candidate.symbol)).map(p => p.candidate.symbol);
  if (skippedOpen.length) console.log(`[agent] skipped (position already open): ${skippedOpen.join(', ')}`);

  for (const { candidate, candidateId } of prepared) {
    if (candidate === selected) continue;
    await updateCandidateStatus(candidateId, 'not_selected');
  }
  if (!selected) return;

  const { candidateId } = prepared.find(p => p.candidate === selected);
  console.log(`[agent] selected ${selected.symbol} ${selected.direction} out of ${prepared.length} candidate(s)`);
  await decideRuleBased(selected, candidateId, strat);
}

/**
 * Dedup, build, filter and persist a raw signal.
 * @returns {Promise<{candidate: object, candidateId: number}|null>} null if deduped or filtered out
 */
async function prepareCandidate(rawSignal, strat) {
  // Deduplicate: same symbol + direction at most once per 15m candle
  pruneSeen(seenSignals, DEDUP_TTL_MS);
  const key = signalDedupKey(rawSignal);
  if (seenSignals.has(key)) return null;
  seenSignals.set(key, now());

  const candidate = await buildCandidate(rawSignal, strat);
  candidate.filters = await filterCandidate(candidate, strat);

  const candidateId = await upsertCandidate(candidate);
  if (!candidate.filters.passed) {
    console.log(`[candidate] filtered ${candidate.symbol} (${candidate.signalType}): ${candidate.filters.failures.join('; ')}`);
    return null;
  }

  console.log(`[candidate] ${candidate.symbol} ${candidate.direction} via ${candidate.signalType} — passed filters`);
  if (candidate.sizingClamped) {
    console.log(`[candidate] ${candidate.symbol} sizing clamped: ${candidate.sizingReason}`);
  }
  return { candidate, candidateId };
}

async function decideRuleBased(candidate, candidateId, strat) {
  const selfRow = await candidateById(candidateId);
  // Use OB-derived TP/SL if available, otherwise fall back to strategy defaults
  const tpPct = candidate.tpPercentOverride ?? strat.tp_percent ?? 2;
  const slPct = candidate.slPercentOverride ?? strat.sl_percent ?? -1.5;
  const decision = {
    verdict: candidate.direction === 'SHORT' ? 'BUY_SHORT' : 'BUY_LONG',
    direction: candidate.direction,
    confidence: 100,
    selected_candidate_id: candidateId,
    selected_symbol: candidate.symbol,
    selected_row: selfRow,
    reason: `Rule-based selection (strategy '${strat.id}'): filters passed, ranked first by confirmation score / R:R / volume.`,
    risks: [],
    suggested_tp_percent: tpPct,
    suggested_sl_percent: slPct,
    raw: null,
  };

  await storeDecision(candidateId, candidate, decision);
  await updateCandidateStatus(candidateId, 'buy');

  if (selfRow && await boolSetting('agent_enabled', 'true') !== false) {
    await handleApprovedBuy(selfRow, decision, null, candidateId);
  }
}

/**
 * LLM decision path (only used when LLM_DECISION_ENABLED and strategy use_llm).
 */
export async function processSignalCandidate(rawSignal, stratOverride = null) {
  const strat = stratOverride || await activeStrategy();
  const positionCount = await openPositionCount();
  if (!await canOpenMorePositions(strat.max_open_positions || 3)) {
    console.log(`[agent] max positions (${positionCount}/${strat.max_open_positions}), skipping ${rawSignal.symbol}`);
    return;
  }

  const prepared = await prepareCandidate(rawSignal, strat);
  if (!prepared) return;
  const { candidate, candidateId } = prepared;

  const rows = await recentEligibleCandidates(await numSetting('llm_candidate_pick_count', 10));
  const batchDecision = await decideCandidateBatch(rows, candidateId);
  const batchId = await storeBatchDecision(candidateId, rows, batchDecision);

  const isBuy = batchDecision.verdict === 'BUY_LONG' || batchDecision.verdict === 'BUY_SHORT';
  const selectedRow = batchDecision.selected_row;

  await storeDecision(candidateId, candidate, batchDecision);
  await updateCandidateStatus(candidateId, isBuy ? 'buy' : batchDecision.verdict.toLowerCase());

  // Notify Telegram when LLM passes/watches a valid candidate
  if (!isBuy) {
    const meta = candidate.signals?.meta || {};
    const isOB = candidate.signalType === 'extreme_ob';
    const lines = [
      `🔍 <b>Candidate Reviewed — ${escapeHtml(candidate.symbol)}</b>`,
      `Verdict: <b>${batchDecision.verdict}</b> | Confidence: <b>${batchDecision.confidence}%</b>`,
      `Signal: <code>${candidate.signalType}</code> | Direction: <b>${candidate.direction}</b>`,
    ];
    if (isOB && meta.rrRatio) {
      lines.push(`R:R: <b>1:${meta.rrRatio}</b> | Entry: <b>${meta.entry}</b>`);
      lines.push(`SL: <b>${meta.stopLoss}</b> | TP: <b>${meta.takeProfit}</b>`);
    }
    if (batchDecision.reason) lines.push(`Reason: <i>${escapeHtml(batchDecision.reason)}</i>`);
    await sendTelegram(lines.join('\n'));
  }

  if (isBuy && selectedRow && await boolSetting('agent_enabled', 'true') !== false) {
    const minConf = await numSetting('llm_min_confidence', strat.llm_min_confidence ?? 70);
    if (batchDecision.confidence < minConf) {
      console.log(`[agent] confidence ${batchDecision.confidence} < threshold ${minConf}, skipping`);
      const meta = candidate.signals?.meta || {};
      await sendTelegram([
        `⚠️ <b>Signal skipped — low confidence</b>`,
        `${escapeHtml(candidate.symbol)} ${candidate.direction} via <code>${candidate.signalType}</code>`,
        `Confidence: <b>${batchDecision.confidence}%</b> < min <b>${minConf}%</b>`,
        meta.rrRatio ? `R:R: <b>1:${meta.rrRatio}</b>` : null,
        batchDecision.reason ? `Reason: <i>${escapeHtml(batchDecision.reason)}</i>` : null,
      ].filter(Boolean).join('\n'));
      return;
    }
    await handleApprovedBuy(selectedRow, batchDecision, batchId, candidateId);
  }
}

async function handleApprovedBuy(selectedRow, decision, batchId, triggerCandidateId) {
  const mode = tradingMode();
  const rowCandidate = selectedRow.candidate || selectedRow;

  if (mode === 'dry_run') {
    const positionId = await createDryRunPosition(selectedRow.id, rowCandidate, decision);
    console.log(`[dry_run] opened position #${positionId} ${rowCandidate.symbol} ${decision.direction} ${rowCandidate.leverage}x`);
    await sendPositionOpen(positionId);
    return;
  }

  if (mode === 'confirm') {
    const intentId = await createTradeIntent(selectedRow.id, rowCandidate, decision, mode, 'pending_confirmation');
    console.log(`[confirm] intent #${intentId} created for ${rowCandidate.symbol} ${decision.direction}`);
    await sendTradeIntent(intentId, rowCandidate, decision);
    return;
  }

  // Live mode
  try {
    const { orderId, liqPrice } = await executeFuturesBuy(rowCandidate, decision);
    rowCandidate.metrics.liqPrice = liqPrice;
    const positionId = await createLivePosition(selectedRow.id, rowCandidate, decision, orderId);
    console.log(`[live] opened position #${positionId} ${rowCandidate.symbol} ${decision.direction} ${rowCandidate.leverage}x order=${orderId}`);
    await sendPositionOpen(positionId);
  } catch (err) {
    console.log(`[live] buy failed ${rowCandidate.symbol}: ${err.message}`);
    await sendTelegram([
      `🛑 <b>Live buy failed</b>`,
      `Symbol: <b>${escapeHtml(rowCandidate.symbol)}</b>`,
      `Direction: <b>${decision.direction}</b>`,
      `Error: ${escapeHtml(err.message)}`,
    ].join('\n'));
  }
}
