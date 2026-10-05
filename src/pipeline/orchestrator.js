import { now } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { upsertCandidate, updateCandidateStatus, recentEligibleCandidates, candidateById } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, createTradeIntent, updateTradeIntentStatus } from '../db/decisions.js';
import { buildCandidate, filterCandidate } from './candidateBuilder.js';
import { decideCandidateBatch } from './llm.js';
import { activeStrategy } from '../db/settings.js';
import { canOpenMorePositions, openPositionCount, openPositions, hasOpenPosition, realizedPnlSince, tradingMode, createDryRunPosition, createLivePosition } from '../db/positions.js';
import { sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { escapeHtml } from '../format.js';
import { executeFuturesBuy } from '../execution/futuresExecutor.js';
import { LLM_DECISION_ENABLED } from '../config.js';
import { shouldUseLlm } from './candidateSelector.js';
import { portfolioBlock, pickCycleEntry } from './portfolioGates.js';
import { checkAndMarkSeen } from './dedup.js';
import { planEntry } from './entryPlan.js';
import { resolveAvailableBalance } from './candidateBuilder.js';
import { fetchPremiumIndex, fetchFuturesBalance } from '../enrichment/binance.js';
import { updateUniverse } from '../enrichment/topGainers.js';
import { getVirtualBalance } from '../db/virtualBalance.js';
import { utcDayStartMs, dailyLossStatus, directionCapReached } from './riskControls.js';
import { RISK_PERCENT_PER_TRADE, MAX_MARGIN_PERCENT_PER_TRADE, SIM_SLIPPAGE_PERCENT, DAILY_LOSS_LIMIT_PERCENT, MAX_SAME_DIRECTION_POSITIONS } from '../config.js';
import { applySlippage } from '../execution/simulation.js';
import { recordSignalEvent } from '../db/signalEvents.js';
import { recordLlmShadow } from './llmShadow.js';

export { seenSignals } from './dedup.js';

/**
 * Entry point for one scan cycle: receives every triggered signal at once.
 * - LLM decision path (only if LLM_DECISION_ENABLED and strategy use_llm):
 *   unchanged per-signal flow, the LLM picks among recent candidates.
 * - Rule-based path (default): build + filter every signal, then a
 *   deterministic selector opens at most ONE new entry for the whole cycle.
 *
 * Universe update (top gainer screener) runs at each cycle; only refreshes
 * watchlist if 15+ min have passed since last update.
 */
export async function processScanCycle(rawSignals) {
  // Update universe (top gainers) — runs at 15m+ intervals
  await updateUniverse().catch(err =>
    console.log(`[orchestrator] universe update failed: ${err.message}`)
  );

  const strat = await activeStrategy();

  const block = await entryBlock();
  if (block) {
    console.log(`[agent] entries blocked: ${block.reason} — skipping cycle of ${rawSignals.length} signal(s)`);
    for (const raw of rawSignals) {
      await recordSignalEvent(raw, { stage: 'pipeline', outcome: 'rejected', reasonCode: block.code, reason: block.reason });
    }
    return;
  }

  if (shouldUseLlm(LLM_DECISION_ENABLED, strat)) {
    for (const rawSignal of rawSignals) {
      await processSignalCandidate(rawSignal, strat).catch(err =>
        console.log(`[agent] ${rawSignal.symbol} failed: ${err.message}`));
    }
    return;
  }

  const maxBlock = portfolioBlock({ openCount: await openPositionCount(), maxOpenPositions: strat.max_open_positions || 3 });
  if (maxBlock) {
    console.log(`[agent] ${maxBlock.reason}, skipping cycle of ${rawSignals.length} signal(s)`);
    for (const raw of rawSignals) {
      await recordSignalEvent(raw, { stage: 'pipeline', outcome: 'rejected', reasonCode: maxBlock.code, reason: maxBlock.reason });
    }
    return;
  }

  const prepared = [];
  for (const rawSignal of rawSignals) {
    const p = await prepareCandidate(rawSignal, strat).catch(async err => {
      console.log(`[candidate] ${rawSignal.symbol} prepare failed: ${err.message}`);
      await recordSignalEvent(rawSignal, { stage: 'pipeline', outcome: 'rejected', reasonCode: 'error', reason: err.message });
      return null;
    });
    if (p) prepared.push(p);
  }
  if (prepared.length === 0) return;

  const { selected, rejections, blockedDirections } = pickCycleEntry(
    prepared.map(p => p.candidate), await openPositions(), MAX_SAME_DIRECTION_POSITIONS);
  if (blockedDirections.length) console.log(`[agent] direction cap (${MAX_SAME_DIRECTION_POSITIONS}) reached for: ${blockedDirections.join(', ')}`);

  for (const { candidate, reasonCode, reason } of rejections) {
    const { candidateId } = prepared.find(p => p.candidate === candidate);
    await updateCandidateStatus(candidateId, 'not_selected');
    await recordSignalEvent(candidate, { stage: 'pipeline', outcome: 'rejected', reasonCode, reason, candidateId });
  }
  const rulePick = selected ? prepared.find(p => p.candidate === selected) : null;
  if (strat.llm_shadow) {
    // Shadow only: not awaited, result is recorded and never affects execution
    recordLlmShadow(prepared, rulePick);
  }
  if (!rulePick) return;

  console.log(`[agent] selected ${selected.symbol} ${selected.direction} out of ${prepared.length} candidate(s)`);
  await decideRuleBased(selected, rulePick.candidateId, strat);
}

/**
 * Dedup, build, filter and persist a raw signal.
 * @returns {Promise<{candidate: object, candidateId: number}|null>} null if deduped or filtered out
 */
async function prepareCandidate(rawSignal, strat) {
  // Deduplicate: same symbol + direction at most once per 15m candle
  if (checkAndMarkSeen(rawSignal, now())) {
    await recordSignalEvent(rawSignal, { stage: 'pipeline', outcome: 'rejected', reasonCode: 'dedup', reason: 'setup already processed on this 15m candle' });
    return null;
  }

  const candidate = await buildCandidate(rawSignal, strat);
  candidate.filters = await filterCandidate(candidate, strat);

  const candidateId = await upsertCandidate(candidate);
  if (!candidate.filters.passed) {
    console.log(`[candidate] filtered ${candidate.symbol} (${candidate.signalType}): ${candidate.filters.failures.join('; ')}`);
    await recordSignalEvent(candidate, { stage: 'pipeline', outcome: 'rejected', reasonCode: 'filter_failed',
      reason: candidate.filters.failures.join('; '), candidateId, details: { failures: candidate.filters.failures } });
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

  if (!selfRow) {
    await recordSignalEvent(candidate, { stage: 'pipeline', outcome: 'rejected', reasonCode: 'candidate_load_failed',
      reason: `candidate #${candidateId} could not be read back from the DB`, candidateId });
  } else if (await boolSetting('agent_enabled', true) !== false) {
    await handleApprovedBuy(selfRow, decision, null, candidateId);
  } else {
    await recordSignalEvent(candidate, { stage: 'pipeline', outcome: 'rejected', reasonCode: 'agent_disabled',
      reason: 'agent_enabled is false', candidateId });
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
    await recordSignalEvent(rawSignal, { stage: 'pipeline', outcome: 'rejected', reasonCode: 'max_positions',
      reason: `max open positions (${strat.max_open_positions}) reached` });
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

  if (!isBuy || !selectedRow) {
    await recordSignalEvent(candidate, { stage: 'pipeline', outcome: 'rejected',
      reasonCode: `llm_${batchDecision.verdict.toLowerCase()}`, reason: batchDecision.reason, candidateId });
  } else if (selectedRow.id !== candidateId) {
    await recordSignalEvent(candidate, { stage: 'pipeline', outcome: 'rejected', reasonCode: 'not_selected',
      reason: `LLM picked candidate #${selectedRow.id}`, candidateId });
  }

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

  if (isBuy && selectedRow && await boolSetting('agent_enabled', true) !== false) {
    const minConf = await numSetting('llm_min_confidence', strat.llm_min_confidence ?? 70);
    if (batchDecision.confidence < minConf) {
      console.log(`[agent] confidence ${batchDecision.confidence} < threshold ${minConf}, skipping`);
      await recordSignalEvent(selectedRow.candidate || selectedRow, { stage: 'pipeline', outcome: 'rejected', reasonCode: 'low_confidence',
        reason: `confidence ${batchDecision.confidence} < ${minConf}`, candidateId: selectedRow.id });
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

let dailyLimitNoticeDay = null;

/**
 * Why new entries are currently blocked, as { code, reason }, or null.
 */
export async function entryBlock() {
  const paused = await boolSetting('entries_paused', false);
  const daily = paused ? null : await dailyLossSnapshot();
  const block = portfolioBlock({ paused, daily, dailyLimitPercent: DAILY_LOSS_LIMIT_PERCENT });
  if (block?.code === 'daily_loss_limit') {
    const day = utcDayStartMs(now());
    if (dailyLimitNoticeDay !== day) {
      dailyLimitNoticeDay = day;
      await sendTelegram(`🛑 <b>Daily loss limit hit</b> (${daily.pnlPercent.toFixed(2)}% ≤ -${DAILY_LOSS_LIMIT_PERCENT}%). No new entries until 00:00 UTC (07:00 WIB).`);
    }
  }
  return block;
}

/** Human-readable entryBlock() reason, or null. Used by Telegram /status and /resume. */
export async function entryBlockReason() {
  return (await entryBlock())?.reason ?? null;
}

/** Today's realized PnL vs start-of-UTC-day balance. */
export async function dailyLossSnapshot() {
  const realizedTodayUsdt = await realizedPnlSince(utcDayStartMs(now()));
  const currentBalanceUsdt = tradingMode() === 'live'
    ? (await fetchFuturesBalance()).walletBalance
    : (await getVirtualBalance()).balance_usdt;
  return { ...dailyLossStatus({ currentBalanceUsdt, realizedTodayUsdt, limitPercent: DAILY_LOSS_LIMIT_PERCENT }), realizedTodayUsdt };
}

async function planAtActualPrice(candidate, decision) {
  let markPrice;
  try {
    markPrice = Number((await fetchPremiumIndex(candidate.symbol)).markPrice);
  } catch (err) {
    return { ok: false, code: 'price_unavailable', reason: `mark price fetch failed: ${err.message}` };
  }
  // Dry-run fills pay simulated slippage, so plan R:R/sizing at the slipped price
  const entryPrice = tradingMode() === 'dry_run'
    ? applySlippage(markPrice, decision.direction, 'entry', SIM_SLIPPAGE_PERCENT)
    : markPrice;
  candidate.metrics.entryMarkPrice = markPrice;
  const strat = await activeStrategy();
  const meta = candidate.signals?.meta || {};
  const availableBalanceUsdt = await resolveAvailableBalance(null);
  if (availableBalanceUsdt === null) return { ok: false, code: 'balance_unavailable', reason: 'balance lookup failed' };
  return planEntry({
    direction: decision.direction,
    entryPrice,
    stopLoss: meta.stopLoss,
    takeProfit: meta.takeProfit,
    fallbackTpPercent: decision.suggested_tp_percent,
    fallbackSlPercent: decision.suggested_sl_percent,
    availableBalanceUsdt,
    riskPercent: RISK_PERCENT_PER_TRADE,
    leverage: candidate.leverage || strat.leverage,
    maxMarginPercent: MAX_MARGIN_PERCENT_PER_TRADE,
  });
}

/** Overwrite signal-time price/levels/sizing with the entry-time plan. */
function applyPlan(candidate, decision, plan) {
  candidate.metrics.markPrice = plan.entryPrice;
  candidate.metrics.liqPrice = plan.liqPrice; // live overwrites with the executor's estimate at fill
  candidate.entryUsdt = plan.entryUsdt;
  candidate.riskUsdt = plan.riskUsdt;
  candidate.signals = candidate.signals || {};
  candidate.signals.meta = { ...(candidate.signals.meta || {}),
    stopLoss: plan.stopLoss, takeProfit: plan.takeProfit, rrAtEntry: Number(plan.rrRatio.toFixed(2)) };
  decision.suggested_tp_percent = plan.tpPercent;
  decision.suggested_sl_percent = plan.slPercent;
}

async function handleApprovedBuy(selectedRow, decision, batchId, triggerCandidateId) {
  const mode = tradingMode();
  const rowCandidate = selectedRow.candidate || selectedRow;
  const candidateId = selectedRow.id;
  const log = (outcome, reasonCode, reason, extra = {}) =>
    recordSignalEvent(rowCandidate, { stage: 'entry', outcome, reasonCode, reason, candidateId, ...extra });

  // One position per symbol, regardless of which path (rule/LLM) chose it
  if (await hasOpenPosition(rowCandidate.symbol)) {
    console.log(`[agent] ${rowCandidate.symbol} already has an open position, skipping entry`);
    return log('rejected', 'symbol_open', 'symbol already has an open position');
  }

  const block = await entryBlock();
  if (block) {
    console.log(`[agent] ${rowCandidate.symbol} entry blocked: ${block.reason}`);
    return log('rejected', block.code, block.reason);
  }
  if (directionCapReached(await openPositions(), decision.direction, MAX_SAME_DIRECTION_POSITIONS)) {
    console.log(`[agent] ${rowCandidate.symbol} skipped: already ${MAX_SAME_DIRECTION_POSITIONS} open ${decision.direction} position(s)`);
    return log('rejected', 'direction_cap', `already ${MAX_SAME_DIRECTION_POSITIONS} open ${decision.direction} position(s)`);
  }

  // Re-plan at the actual entry price (signal levels were computed from OB mid)
  const plan = await planAtActualPrice(rowCandidate, decision);
  if (!plan.ok) {
    console.log(`[agent] ${rowCandidate.symbol} rejected at entry: ${plan.reason}`);
    await updateCandidateStatus(candidateId, 'rejected_at_entry');
    await log('rejected', plan.code || 'rejected_at_entry', plan.reason, { details: planDetails(plan) });
    await sendTelegram(`⛔ <b>Entry cancelled — ${escapeHtml(rowCandidate.symbol)} ${decision.direction}</b>\n${escapeHtml(plan.reason)}`);
    return;
  }
  applyPlan(rowCandidate, decision, plan);

  if (mode === 'dry_run') {
    try {
      const positionId = await createDryRunPosition(candidateId, rowCandidate, decision);
      console.log(`[dry_run] opened position #${positionId} ${rowCandidate.symbol} ${decision.direction} ${rowCandidate.leverage}x`);
      await log('executed', 'opened', `dry_run position #${positionId}`, { positionId, details: planDetails(plan) });
      await sendPositionOpen(positionId);
    } catch (err) {
      console.log(`[dry_run] open failed ${rowCandidate.symbol}: ${err.message}`);
      await log('rejected', 'open_failed', err.message, { details: planDetails(plan) });
    }
    return;
  }

  if (mode === 'confirm') {
    const intentId = await createTradeIntent(candidateId, rowCandidate, decision, mode, 'pending_confirmation');
    console.log(`[confirm] intent #${intentId} created for ${rowCandidate.symbol} ${decision.direction}`);
    await log('pending_confirmation', 'intent_created', `intent #${intentId}`, { details: planDetails(plan) });
    await sendTradeIntent(intentId, rowCandidate, decision);
    return;
  }

  // Live mode
  try {
    const { orderId, liqPrice, fillPrice, quantity } = await executeFuturesBuy(rowCandidate, decision);
    rowCandidate.metrics.liqPrice = liqPrice;
    const positionId = await createLivePosition(candidateId, rowCandidate, decision, orderId, { fillPrice, quantity });
    console.log(`[live] opened position #${positionId} ${rowCandidate.symbol} ${decision.direction} ${rowCandidate.leverage}x order=${orderId}`);
    await log('executed', 'opened', `live position #${positionId} order ${orderId}`, { positionId, details: { ...planDetails(plan), fillPrice, quantity } });
    await sendPositionOpen(positionId);
  } catch (err) {
    console.log(`[live] buy failed ${rowCandidate.symbol}: ${err.message}`);
    await log('rejected', 'order_failed', err.message, { details: planDetails(plan) });
    await sendTelegram([
      `🛑 <b>Live buy failed</b>`,
      `Symbol: <b>${escapeHtml(rowCandidate.symbol)}</b>`,
      `Direction: <b>${decision.direction}</b>`,
      `Error: ${escapeHtml(err.message)}`,
    ].join('\n'));
  }
}

function planDetails(plan) {
  const { ok, code, reason, ...rest } = plan;
  return rest;
}
