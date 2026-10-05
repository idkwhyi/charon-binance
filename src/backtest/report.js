import { getBacktestRun, getBacktestBalance, getBacktestPositions } from '../db/backtest.js';
import { fromJsonb } from '../db/pg-connection.js';

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const EXIT_TYPES = ['SL', 'TP', 'MAX_HOLD', 'LIQ_GUARD'];

/**
 * Trade statistics for a set of closed positions (all, one symbol, or one
 * direction). PnL and R are net of fees and slippage (as settled by
 * simulation.js). Max drawdown is on realized equity, starting from
 * `startingBalance`, in close-time order.
 * @param {Array} closed - backtest_positions rows (pg strings ok)
 * @param {{ days: number, startingBalance: number }} ctx
 */
export function summarizeTrades(closed, { days, startingBalance }) {
  const rows = [...closed].sort((a, b) => Number(a.closed_at_ms) - Number(b.closed_at_ms));
  const pnls = rows.map(p => Number(p.pnl_usdt) || 0);
  const wins = pnls.filter(x => x > 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnls.filter(x => x <= 0).reduce((a, b) => a + b, 0));
  const rs = rows.map(p => p.pnl_r).filter(r => r !== null && r !== undefined && Number.isFinite(Number(r))).map(Number);

  let equity = startingBalance, peak = startingBalance, maxDdUsdt = 0, maxDdPercent = 0;
  for (const x of pnls) {
    equity += x;
    peak = Math.max(peak, equity);
    maxDdUsdt = Math.max(maxDdUsdt, peak - equity);
    maxDdPercent = Math.max(maxDdPercent, peak > 0 ? (peak - equity) / peak * 100 : 0);
  }

  const exits = Object.fromEntries(EXIT_TYPES.map(t => [t, 0]));
  for (const p of rows) {
    const reason = p.exit_reason || 'UNKNOWN';
    exits[reason] = (exits[reason] || 0) + 1;
  }

  return {
    trades: rows.length,
    tradesPerDay: days > 0 ? rows.length / days : 0,
    wins: wins.length,
    losses: rows.length - wins.length,
    winRate: rows.length ? wins.length / rows.length * 100 : 0,
    expectancyR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    tradesWithR: rs.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    totalPnl: pnls.reduce((a, b) => a + b, 0),
    maxDrawdownUsdt: maxDdUsdt,
    maxDrawdownPercent: maxDdPercent,
    fees: rows.reduce((a, p) => a + Number(p.fee_usdt || 0), 0),
    slippage: rows.reduce((a, p) => a + Number(p.slippage_usdt || 0), 0),
    exits,
  };
}

/** Collapse per-signal outcomes into counted rows for storage. */
export function aggregateOutcomes(events) {
  const map = new Map();
  for (const e of events) {
    const key = [e.symbol, e.direction ?? '', e.stage, e.outcome, e.reasonCode].join('|');
    const row = map.get(key) || { symbol: e.symbol, direction: e.direction ?? null, stage: e.stage, outcome: e.outcome, reason_code: e.reasonCode, count: 0 };
    row.count++;
    map.set(key, row);
  }
  return [...map.values()];
}

/**
 * Rejected / watched signal counts per reason code, overall and split by
 * symbol and direction. Executed outcomes are excluded.
 */
export function summarizeOutcomes(rows = []) {
  const tally = (filter) => {
    const out = {};
    for (const r of rows) {
      if (!filter(r)) continue;
      const k = `${r.outcome}:${r.reason_code}`;
      out[k] = (out[k] || 0) + r.count;
    }
    return out;
  };
  const relevant = r => r.outcome === 'rejected' || r.outcome === 'watch';
  const symbols = [...new Set(rows.filter(relevant).map(r => r.symbol))].sort();
  return {
    overall: tally(relevant),
    bySymbol: Object.fromEntries(symbols.map(s => [s, tally(r => relevant(r) && r.symbol === s)])),
    byDirection: Object.fromEntries(['LONG', 'SHORT'].map(d => [d, tally(r => relevant(r) && r.direction === d)])),
  };
}

/**
 * Universe membership and OI coverage of a run (from backtest_runs.params_json),
 * plus results split between the core watchlist and dynamically added symbols.
 */
export function summarizeUniverse(params, closed, ctx) {
  const u = params?.universe;
  const core = new Set(u?.core || []);
  const members = [...(u?.members || [])]
    .map(m => ({ symbol: m.symbol, totalMs: m.totalMs, intervals: m.intervals?.length || 0, core: core.has(m.symbol), delisted: (u?.delisted || []).includes(m.symbol) }))
    .sort((a, b) => b.totalMs - a.totalMs || a.symbol.localeCompare(b.symbol));
  const oi = params?.openInterest || null;
  return {
    mode: u?.mode || 'fixed',
    core: [...core],
    members,
    dynamicCount: members.filter(m => !m.core).length,
    delisted: members.filter(m => m.delisted).map(m => m.symbol),
    events: (u?.events || []).length,
    avgSize: u?.stats?.avgSize ?? null,
    maxSize: u?.stats?.maxSize ?? null,
    excludedUnknownType: u?.excludedUnknownType || [],
    oi: oi && {
      ...oi,
      coveragePercent: oi.lookups > 0 ? oi.found / oi.lookups * 100 : null,
    },
    // Fixed runs have no params (older runs) or core = all symbols: everything is core
    results: {
      core: summarizeTrades(closed.filter(p => !u || core.has(p.symbol)), ctx),
      dynamic: summarizeTrades(closed.filter(p => u && !core.has(p.symbol)), ctx),
    },
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

  const startingBalance = Number(run.starting_balance);
  const finalBalance = Number(balance.balance_usdt);
  const totalReturn = startingBalance > 0 ? (finalBalance - startingBalance) / startingBalance * 100 : 0;
  const days = Math.max(1 / 96, (Number(run.date_to_ms) - Number(run.date_from_ms)) / DAY_MS);
  const ctx = { days, startingBalance };

  const bySymbol = new Map();
  for (const [sym, group] of groupBy(closed, p => p.symbol)) bySymbol.set(sym, summarizeTrades(group, ctx));
  const byDirection = new Map();
  for (const dir of ['LONG', 'SHORT']) byDirection.set(dir, summarizeTrades(closed.filter(p => p.direction === dir), ctx));

  return {
    run,
    startingBalance,
    finalBalance,
    totalReturn,
    days,
    openTrades: positions.length - closed.length,
    overall: summarizeTrades(closed, ctx),
    bySymbol,
    byDirection,
    signals: summarizeOutcomes(run.signal_outcomes_json || []),
    universe: summarizeUniverse(fromJsonb(run.params_json) || {}, closed, ctx),
    equityCurve: balance.equity_curve_json || [],
  };
}

const pct = n => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const usd = n => `${n >= 0 ? '+' : ''}${n.toFixed(2)} USDT`;

const r2 = n => (n === null || n === undefined ? 'n/a' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`);
const pf = n => (Number.isFinite(n) ? n.toFixed(2) : '∞');

function exitLine(exits) {
  return Object.entries(exits).filter(([k, v]) => EXIT_TYPES.includes(k) || v > 0).map(([k, v]) => `${k} ${v}`).join(' | ');
}

function statsLines(s) {
  return [
    `Trades:            ${s.trades} (${s.tradesPerDay.toFixed(2)}/day)`,
    `Win rate:          ${s.winRate.toFixed(1)}% (${s.wins}W / ${s.losses}L)`,
    `Expectancy:        ${r2(s.expectancyR)} per trade, net of fees & slippage${s.tradesWithR < s.trades ? ` (R known for ${s.tradesWithR}/${s.trades})` : ''}`,
    `Profit factor:     ${pf(s.profitFactor)}`,
    `Net PnL:           ${usd(s.totalPnl)} (fees ${s.fees.toFixed(2)}, slippage ${s.slippage.toFixed(2)})`,
    `Max drawdown:      ${s.maxDrawdownPercent.toFixed(2)}% (${s.maxDrawdownUsdt.toFixed(2)} USDT)`,
    `Exits:             ${exitLine(s.exits)}`,
  ];
}

function compactLine(label, s) {
  return `${label.padEnd(12)} trades=${String(s.trades).padEnd(4)} ${s.tradesPerDay.toFixed(2)}/d  win=${s.winRate.toFixed(1).padStart(5)}%  E=${r2(s.expectancyR).padStart(7)}  PF=${pf(s.profitFactor).padStart(5)}  DD=${s.maxDrawdownPercent.toFixed(2)}%  ${exitLine(s.exits)}`;
}

const dur = ms => {
  const h = ms / 3_600_000;
  return h >= 48 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`;
};

function universeLines(u, line) {
  const out = [
    '🌐 UNIVERSE', line,
    `Mode:              ${u.mode}${u.mode === 'dynamic' ? ' (point-in-time, src/universe/rules.js at every 15m close)' : ''}`,
    `Core watchlist:    ${u.core.length ? u.core.join(', ') : '(none)'}`,
  ];
  if (u.mode === 'dynamic') {
    out.push(
      `Ever in universe:  ${u.members.length} symbol(s), ${u.dynamicCount} dynamic; ${u.events} enter/exit events`,
      `Size:              avg ${u.avgSize?.toFixed(1) ?? 'n/a'}, max ${u.maxSize ?? 'n/a'}`,
      `Delisted entered:  ${u.delisted.length}${u.delisted.length ? ` (${u.delisted.join(', ')})` : ''}`,
    );
    if (u.excludedUnknownType.length) {
      out.push(`Unknown type out:  ${u.excludedUnknownType.length} symbol(s) would have qualified but have no underlyingType (--unknown-underlying coin to include): ${u.excludedUnknownType.join(', ')}`);
    }
    out.push('', '  Symbol               Total time   Stints');
    for (const m of u.members) {
      out.push(`  ${(m.symbol + (m.core ? ' (core)' : '') + (m.delisted ? ' †' : '')).padEnd(20)} ${dur(m.totalMs).padStart(10)}   ${String(m.intervals).padStart(6)}`);
    }
    if (u.delisted.length) out.push('  † delisted since');
  }
  return out;
}

function oiLines(oi, line) {
  if (!oi) return [];
  const out = ['', '📊 OPEN INTEREST DATA (min_open_interest_usdt)', line];
  if (!(oi.minOpenInterestUsdt > 0)) return [...out, 'Filter off (strategy min_open_interest_usdt = 0).'];
  out.push(
    `Filter:            OI >= ${oi.minOpenInterestUsdt} USDT; missing data → ${oi.missingPolicy === 'reject' ? 'candidate rejected' : 'filter ignored'}`,
    `Coverage:          ${oi.found}/${oi.lookups} candidate lookups had OI${oi.coveragePercent === null ? '' : ` (${oi.coveragePercent.toFixed(1)}%)`}; metrics days with data ${oi.daysWithData}/${oi.daysRequested}`,
    `Rejected (no OI):  ${oi.rejectedMissing}`,
  );
  const gaps = Object.entries(oi.bySymbol || {}).filter(([, s]) => s.found < s.lookups).sort((a, b) => (b[1].lookups - b[1].found) - (a[1].lookups - a[1].found));
  if (gaps.length) out.push(`Missing by symbol: ${gaps.map(([sym, s]) => `${sym} ${s.lookups - s.found}/${s.lookups}`).join(', ')}`);
  return out;
}

function tallyLines(tally) {
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return ['  (none)'];
  return entries.map(([k, n]) => {
    const [outcome, code] = k.split(':');
    return `  ${code.padEnd(24)} ${String(n).padStart(6)}${outcome === 'watch' ? '  (watch)' : ''}`;
  });
}

export function formatBacktestReport(report) {
  const { run } = report;
  const symbols = Array.isArray(run.symbols_json) ? run.symbols_json.join(',') : run.symbols_json;
  const line = '─────────────────────────────────────────────────────────';
  const out = [
    '',
    '═══════════════════════════════════════════════════════════',
    `           📊 BACKTEST REPORT — Run #${run.id}`,
    '═══════════════════════════════════════════════════════════',
    '',
    `Label:      ${run.label}`,
    `Strategy:   ${run.strategy_id}`,
    `Symbols:    ${report.universe?.mode === 'dynamic' ? `${report.universe.members.length} over the run (see UNIVERSE)` : symbols}`,
    `Range:      ${new Date(Number(run.date_from_ms)).toISOString()} -> ${new Date(Number(run.date_to_ms)).toISOString()} (${report.days.toFixed(1)} days)`,
    `Costs:      slippage ${Number(run.slippage_percent)}% + fee ${Number(run.fee_percent)}% per side`,
    `Status:     ${run.status}${run.error ? ` (${run.error})` : ''}`,
    '',
    '💰 BALANCE', line,
    `Starting:          ${report.startingBalance.toFixed(2)} USDT`,
    `Final:             ${report.finalBalance.toFixed(2)} USDT (${pct(report.totalReturn)})`,
    '',
    `📈 SUMMARY${report.openTrades ? ` (+${report.openTrades} still open)` : ''}`, line,
    ...statsLines(report.overall),
    '',
    ...universeLines(report.universe, line),
    ...oiLines(report.universe.oi, line),
    '',
    '🧩 CORE WATCHLIST vs DYNAMIC SYMBOLS', line,
    compactLine('core', report.universe.results.core),
    compactLine('dynamic', report.universe.results.dynamic),
    '',
    '  Core watchlist:',
    ...statsLines(report.universe.results.core).map(l => `  ${l}`),
    '',
    '  Dynamic symbols:',
    ...statsLines(report.universe.results.dynamic).map(l => `  ${l}`),
    '',
    '🧭 BY DIRECTION', line,
    ...[...report.byDirection].map(([d, s]) => compactLine(d, s)),
    '',
    '🪙 BY SYMBOL', line,
    ...([...report.bySymbol].map(([sym, s]) => compactLine(sym, s))),
    ...(report.bySymbol.size ? [] : ['  (no trades)']),
    '',
    '🚫 SIGNALS NOT TAKEN (per reason code)', line,
    ...tallyLines(report.signals.overall),
    '',
    '  By direction:',
    ...Object.entries(report.signals.byDirection).flatMap(([d, t]) => [`  ${d}`, ...tallyLines(t).map(l => `  ${l}`)]),
    '',
    '  By symbol:',
    ...Object.entries(report.signals.bySymbol).flatMap(([sym, t]) => [`  ${sym}`, ...tallyLines(t).map(l => `  ${l}`)]),
    '',
    `📉 Equity curve: ${report.equityCurve.length} points stored in backtest_balance.equity_curve_json.`,
    '═══════════════════════════════════════════════════════════',
    '',
  ];
  return out.join('\n');
}

export function printBacktestReport(report) {
  console.log(formatBacktestReport(report));
}
