import { now, pruneSeen } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { upsertCandidate, updateCandidateStatus, recentEligibleCandidates, candidateById } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, createTradeIntent, updateTradeIntentStatus } from '../db/decisions.js';
import { buildCandidate, filterCandidate } from './candidateBuilder.js';
import { decideCandidateBatch } from './llm.js';
import { activeStrategy } from '../db/settings.js';
import { canOpenMorePositions, openPositionCount, tradingMode, createDryRunPosition, createLivePosition } from '../db/positions.js';
import { sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { escapeHtml } from '../format.js';
import { executeFuturesBuy } from '../execution/futuresExecutor.js';

export const seenSignals = new Map();

export async function processSignalCandidate(rawSignal) {
  // Deduplicate: same symbol + signal_type within 5 min
  pruneSeen(seenSignals, 5 * 60_000);
  const bucket = Math.floor(now() / (5 * 60_000));
  const key = `${rawSignal.symbol}:${rawSignal.signalType}:${bucket}`;
  if (seenSignals.has(key)) return;
  seenSignals.set(key, now());

  const strat = activeStrategy();
  if (!canOpenMorePositions(strat.max_open_positions || 3)) {
    console.log(`[agent] max positions (${openPositionCount()}/${strat.max_open_positions}), skipping ${rawSignal.symbol}`);
    return;
  }

  // Build & filter candidate
  const candidate = buildCandidate(rawSignal);
  candidate.filters = filterCandidate(candidate);

  const candidateId = upsertCandidate(candidate);
  if (!candidate.filters.passed) {
    console.log(`[candidate] filtered ${candidate.symbol} (${candidate.signalType}): ${candidate.filters.failures.join('; ')}`);
    return;
  }

  console.log(`[candidate] ${candidate.symbol} ${candidate.direction} via ${candidate.signalType} — passed filters`);

  let batchDecision, batchId;

  if (!strat.use_llm) {
    // Rule-based: auto-approve
    const selfRow = candidateById(candidateId);
    // Use OB-derived TP/SL if available, otherwise fall back to strategy defaults
    const tpPct = candidate.tpPercentOverride ?? strat.tp_percent ?? 2;
    const slPct = candidate.slPercentOverride ?? strat.sl_percent ?? -1.5;
    batchDecision = {
      verdict: candidate.direction === 'SHORT' ? 'BUY_SHORT' : 'BUY_LONG',
      direction: candidate.direction,
      confidence: 100,
      selected_candidate_id: candidateId,
      selected_symbol: candidate.symbol,
      selected_row: selfRow,
      reason: `Strategy '${strat.id}' is rule-based (use_llm: false); filters passed.`,
      risks: [],
      suggested_tp_percent: tpPct,
      suggested_sl_percent: slPct,
      raw: null,
    };
    batchId = null;
  } else {
    const rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10));
    batchDecision = await decideCandidateBatch(rows, candidateId);
    batchId = storeBatchDecision(candidateId, rows, batchDecision);
  }

  const isBuy = batchDecision.verdict === 'BUY_LONG' || batchDecision.verdict === 'BUY_SHORT';
  const selectedRow = batchDecision.selected_row;

  storeDecision(candidateId, candidate, batchDecision);
  updateCandidateStatus(candidateId, isBuy ? 'buy' : batchDecision.verdict.toLowerCase());

  // Notify Telegram when LLM passes/watches a valid candidate
  if (!isBuy && strat.use_llm) {
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

  if (isBuy && selectedRow && boolSetting('agent_enabled', 'true') !== false) {
    const minConf = numSetting('llm_min_confidence', strat.llm_min_confidence ?? 70);
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
    const positionId = createDryRunPosition(selectedRow.id, rowCandidate, decision);
    console.log(`[dry_run] opened position #${positionId} ${rowCandidate.symbol} ${decision.direction} ${rowCandidate.leverage}x`);
    await sendPositionOpen(positionId);
    return;
  }

  if (mode === 'confirm') {
    const intentId = createTradeIntent(selectedRow.id, rowCandidate, decision, mode, 'pending_confirmation');
    console.log(`[confirm] intent #${intentId} created for ${rowCandidate.symbol} ${decision.direction}`);
    await sendTradeIntent(intentId, rowCandidate, decision);
    return;
  }

  // Live mode
  try {
    const { orderId, liqPrice } = await executeFuturesBuy(rowCandidate, decision);
    rowCandidate.metrics.liqPrice = liqPrice;
    const positionId = createLivePosition(selectedRow.id, rowCandidate, decision, orderId);
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
