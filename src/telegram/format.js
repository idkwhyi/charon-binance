import { fmtUsd, fmtPct, escapeHtml, dirEmoji } from '../format.js';

/**
 * Format candidate summary for Telegram.
 */
export function candidateSummary(candidate, decision) {
  const dir = decision.direction || candidate.direction;
  const m = candidate.metrics || {};
  const meta = candidate.signals?.meta || {};
  const isOB = candidate.signalType === 'extreme_ob';

  const lines = [
    `${dirEmoji(dir)} <b>${escapeHtml(candidate.symbol)}</b> — <b>${dir}</b> ${candidate.leverage}x`,
    `Signal: <code>${escapeHtml(candidate.signalType)}</code> | Strategy: <code>${escapeHtml(candidate.strategyId)}</code>`,
    `Mark Price: <b>${fmtUsd(m.markPrice)}</b>`,
    `Volume 24h: <b>${fmtUsd(m.volume24hUsdt)}</b>`,
    m.openInterestUsdt != null ? `Open Interest: <b>${fmtUsd(m.openInterestUsdt)}</b>` : null,
    m.fundingRate != null ? `Funding Rate: <b>${(Number(m.fundingRate) * 100).toFixed(4)}%</b>` : null,
  ];

  // Extreme OB specific details
  if (isOB && meta.trend) {
    lines.push(``);
    lines.push(`📊 <b>Market Structure: ${meta.trend}</b>`);
    lines.push(`Last HH: <b>${fmtUsd(meta.lastHH ?? meta.lastSwingHigh)}</b> | Last HL: <b>${fmtUsd(meta.lastHL ?? meta.lastSwingLow)}</b>`);
    if (meta.trend === 'DOWNTREND') {
      lines.push(`Last LH: <b>${fmtUsd(meta.lastLH ?? meta.lastSwingHigh)}</b> | Last LL: <b>${fmtUsd(meta.lastLL ?? meta.lastSwingLow)}</b>`);
    }
    lines.push(``);
    lines.push(`🟦 <b>Order Block Zone</b>`);
    lines.push(`OB High: <b>${fmtUsd(meta.obHigh)}</b> | OB Low: <b>${fmtUsd(meta.obLow)}</b>`);
    lines.push(`Impulse: <b>${Number(meta.obImpulseSize || 0).toFixed(2)}%</b>`);
    lines.push(``);
    lines.push(`📐 <b>Fibonacci Levels</b>`);
    if (meta.fibLevels) {
      lines.push(`70.5%: <b>${fmtUsd(meta.fibLevels['70.5%'])}</b> | 78.6%: <b>${fmtUsd(meta.fibLevels['78.6%'])}</b>`);
    }
    lines.push(`In Fib Zone: <b>${meta.inFibZone ? '✅' : '❌'}</b> | In OB Zone: <b>${meta.inOBZone ? '✅' : '❌'}</b>`);
    lines.push(``);
    lines.push(`🎯 <b>Trade Levels</b>`);
    lines.push(`Entry: <b>${fmtUsd(meta.entry)}</b>`);
    lines.push(`SL: <b>${fmtUsd(meta.stopLoss)}</b> <i>(below ${meta.slAnchorLabel ?? 'swing low'}: ${fmtUsd(meta.slAnchorPrice)})</i>`);
    lines.push(`TP: <b>${fmtUsd(meta.takeProfit)}</b>`);
    lines.push(`R:R — <b>1:${Number(meta.rrRatio || 0).toFixed(2)}</b> (min 1:${meta.minRR ?? 2})`);
  }

  lines.push(``);
  lines.push(`TP: <b>${fmtPct(decision.suggested_tp_percent)}</b> | SL: <b>${fmtPct(decision.suggested_sl_percent)}</b>`);
  lines.push(`Confidence: <b>${decision.confidence}%</b>`);
  if (decision.reason) lines.push(`Reason: <i>${escapeHtml(decision.reason)}</i>`);

  return lines.filter(l => l !== null).join('\n');
}

/**
 * Format position summary for Telegram.
 */
export function positionSummary(position) {
  const pnl = Number(position.pnl_percent || position.pnlPercent || 0);
  const pnlUsdt = Number(position.pnl_usdt || position.pnlUsdt || 0);
  const emoji = pnl >= 0 ? '📈' : '📉';
  return [
    `${emoji} <b>#${position.id} ${escapeHtml(position.symbol)}</b> ${position.direction} ${position.leverage}x`,
    `Entry: <b>${fmtUsd(position.entry_price)}</b> | Mark: <b>${fmtUsd(position.markPrice || position.exit_price)}</b>`,
    `PnL: <b>${fmtPct(pnl)}</b> (${pnlUsdt >= 0 ? '+' : ''}${pnlUsdt.toFixed(2)} USDT)`,
    position.liq_price ? `Liq: <b>${fmtUsd(position.liq_price)}</b>` : null,
    `Mode: <code>${position.execution_mode}</code>`,
  ].filter(l => l !== null).join('\n');
}

/**
 * Format a list of open positions.
 */
export function openPositionsList(positions) {
  if (!positions.length) return '📭 No open positions.';
  return positions.map(p => positionSummary(p)).join('\n\n');
}
