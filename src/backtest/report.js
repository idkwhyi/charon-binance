import { getBacktestRun, getBacktestBalance, getBacktestPositions } from '../db/backtest.js';

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function statsFor(positions) {
  const wins = positions.filter(p => Number(p.pnl_usdt) > 0);
  const totalPnl = positions.reduce((s, p) => s + Number(p.pnl_usdt), 0);
  return {
    count: positions.length,
    wins: wins.length,
    winRate: positions.length ? (wins.length / positions.length) * 100 : 0,
    totalPnl,
  };
}

/**
 * Aggregate a completed (or in-progress) backtest run into report-ready stats.
 * All numeric DB fields are wrapped in Number() because pg returns
 * DECIMAL/BIGINT columns as strings to avoid precision loss.
 */
export async function buildBacktestReport(runId) {
  const run = await getBacktestRun(runId);
  if (!run) throw new Error(`Backtest run #${runId} not found`);

  const balance = await getBacktestBalance(runId);
  const positions = await getBacktestPositions(runId);
  const closed = positions.filter(p => p.status === 'closed');

  const wins = closed.filter(p => Number(p.pnl_usdt) > 0);
  const losses = closed.filter(p => Number(p.pnl_usdt) <= 0);
  const totalWinAmount = wins.reduce((s, p) => s + Number(p.pnl_usdt), 0);
  const totalLossAmount = Math.abs(losses.reduce((s, p) => s + Number(p.pnl_usdt), 0));
  const profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : (totalWinAmount > 0 ? Infinity : 0);
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
  const avgWin = wins.length ? totalWinAmount / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, p) => s + Number(p.pnl_usdt), 0) / losses.length : 0;
  const expectancy = closed.length ? closed.reduce((s, p) => s + Number(p.pnl_usdt), 0) / closed.length : 0;
  const totalFees = closed.reduce((s, p) => s + Number(p.fee_usdt || 0), 0);
  const totalSlippageCost = closed.reduce((s, p) => s + Number(p.slippage_usdt || 0), 0);

  const startingBalance = Number(run.starting_balance);
  const finalBalance = Number(balance.balance_usdt);
  const totalReturn = startingBalance > 0 ? (finalBalance - startingBalance) / startingBalance * 100 : 0;

  const bySignal = new Map();
  for (const [type, group] of groupBy(closed, p => p.signal_type)) bySignal.set(type, statsFor(group));

  const bySymbol = new Map();
  for (const [sym, group] of groupBy(closed, p => p.symbol)) bySymbol.set(sym, statsFor(group));

  const byExitReason = new Map();
  for (const [reason, group] of groupBy(closed, p => p.exit_reason || 'UNKNOWN')) byExitReason.set(reason, group.length);

  return {
    run,
    startingBalance,
    finalBalance,
    totalReturn,
    peakBalance: Number(balance.peak_balance),
    maxDrawdownPercent: Number(balance.max_drawdown_percent),
    totalTrades: closed.length,
    openTrades: positions.length - closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    profitFactor,
    avgWin,
    avgLoss,
    expectancy,
    totalFees,
    totalSlippageCost,
    bySignal,
    bySymbol,
    byExitReason,
    equityCurve: balance.equity_curve_json || [],
  };
}

const pct = n => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const usd = n => `${n >= 0 ? '+' : ''}${n.toFixed(2)} USDT`;

export function printBacktestReport(report) {
  const { run } = report;
  const symbols = Array.isArray(run.symbols_json) ? run.symbols_json.join(',') : run.symbols_json;

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`           📊 BACKTEST REPORT — Run #${run.id}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log(`Label:      ${run.label}`);
  console.log(`Strategy:   ${run.strategy_id}`);
  console.log(`Symbols:    ${symbols}`);
  console.log(`Range:      ${new Date(Number(run.date_from_ms)).toISOString()} -> ${new Date(Number(run.date_to_ms)).toISOString()}`);
  console.log(`Status:     ${run.status}${run.error ? ` (${run.error})` : ''}`);
  console.log('');

  console.log('💰 BALANCE');
  console.log('─────────────────────────────────────────────────────────');
  console.log(`Starting:          ${report.startingBalance.toFixed(2)} USDT`);
  console.log(`Final:             ${report.finalBalance.toFixed(2)} USDT`);
  console.log(`Total Return:      ${pct(report.totalReturn)}`);
  console.log(`Peak Balance:      ${report.peakBalance.toFixed(2)} USDT`);
  console.log(`Max Drawdown:      ${report.maxDrawdownPercent.toFixed(2)}%`);
  console.log('');

  console.log('📈 TRADE STATS');
  console.log('─────────────────────────────────────────────────────────');
  console.log(`Total Trades:      ${report.totalTrades}${report.openTrades ? ` (+${report.openTrades} still open)` : ''}`);
  console.log(`Wins / Losses:     ${report.wins}W / ${report.losses}L`);
  console.log(`Win Rate:          ${report.winRate.toFixed(1)}%`);
  console.log(`Profit Factor:     ${Number.isFinite(report.profitFactor) ? report.profitFactor.toFixed(2) : '∞'}`);
  console.log(`Avg Win:           ${usd(report.avgWin)}`);
  console.log(`Avg Loss:          ${usd(report.avgLoss)}`);
  console.log(`Expectancy/Trade:  ${usd(report.expectancy)}`);
  console.log('');

  console.log('💸 COSTS');
  console.log('─────────────────────────────────────────────────────────');
  console.log(`Total Fees:        ${report.totalFees.toFixed(2)} USDT`);
  console.log(`Total Slippage:    ${report.totalSlippageCost.toFixed(2)} USDT`);
  console.log('');

  if (report.bySignal.size > 0) {
    console.log('🔍 BY SIGNAL TYPE');
    console.log('─────────────────────────────────────────────────────────');
    for (const [type, s] of report.bySignal) {
      console.log(`${type.padEnd(20)} trades=${String(s.count).padEnd(5)} winRate=${s.winRate.toFixed(1).padStart(5)}%  pnl=${usd(s.totalPnl)}`);
    }
    console.log('');
  }

  if (report.bySymbol.size > 0) {
    console.log('🪙 BY SYMBOL');
    console.log('─────────────────────────────────────────────────────────');
    for (const [sym, s] of report.bySymbol) {
      console.log(`${sym.padEnd(12)} trades=${String(s.count).padEnd(5)} winRate=${s.winRate.toFixed(1).padStart(5)}%  pnl=${usd(s.totalPnl)}`);
    }
    console.log('');
  }

  if (report.byExitReason.size > 0) {
    console.log('🚪 EXIT REASONS');
    console.log('─────────────────────────────────────────────────────────');
    for (const [reason, count] of report.byExitReason) {
      console.log(`${reason.padEnd(15)} ${count}`);
    }
    console.log('');
  }

  console.log(`📉 Equity curve: ${report.equityCurve.length} points stored in backtest_balance.equity_curve_json (for charting later).`);
  console.log('═══════════════════════════════════════════════════════════\n');
}
