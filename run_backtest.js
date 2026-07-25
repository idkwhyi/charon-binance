#!/usr/bin/env node
import 'dotenv/config';
import { initPgDb, closePgDb } from './src/db/pg-connection.js';
import { runBacktest } from './src/backtest/runner.js';
import { getBacktestRun, getBacktestBalance } from './src/db/backtest.js';

/**
 * CLI runner for the historical backtest engine.
 * Full performance reporting (equity curve, per-signal breakdown, profit
 * factor, ...) lands in the next step — this just proves the replay works
 * end-to-end and prints a raw summary.
 *
 * Usage:
 *   node run_backtest.js --symbols BTCUSDT,ETHUSDT --strategy scalp \
 *     --from 2026-01-01 --to 2026-06-01 --balance 1000 --fee 0.04 --slippage 0.02
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[key] = value;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.symbols || !args.strategy || !args.from || !args.to) {
    console.error('Usage: node run_backtest.js --symbols BTCUSDT,ETHUSDT --strategy scalp --from 2026-01-01 --to 2026-06-01 [--balance 1000] [--fee 0.04] [--slippage 0.02] [--label "my run"]');
    process.exit(1);
  }

  const symbols = args.symbols.split(',').map(s => s.trim().toUpperCase());
  const dateFromMs = new Date(args.from).getTime();
  const dateToMs = new Date(args.to).getTime();

  if (!Number.isFinite(dateFromMs) || !Number.isFinite(dateToMs) || dateFromMs >= dateToMs) {
    console.error('Invalid --from/--to date range.');
    process.exit(1);
  }

  await initPgDb();

  const runId = await runBacktest({
    label: args.label || `${args.strategy}_${args.from}_${args.to}`,
    strategyId: args.strategy,
    symbols,
    dateFromMs,
    dateToMs,
    startingBalance: Number(args.balance || 1000),
    feePercent: Number(args.fee || 0.04),
    slippagePercent: Number(args.slippage || 0.02),
  });

  const run = await getBacktestRun(runId);
  const balance = await getBacktestBalance(runId);
  console.log('\n─────────────────────────────────────────────');
  console.log(`Run #${runId} — raw summary`);
  console.log('─────────────────────────────────────────────');
  console.log(`Starting balance:  ${Number(run.starting_balance).toFixed(2)} USDT`);
  console.log(`Final balance:     ${Number(balance.balance_usdt).toFixed(2)} USDT`);
  console.log(`Total trades:      ${balance.total_trades}`);
  console.log(`Wins / Losses:     ${balance.winning_trades}W / ${balance.losing_trades}L`);
  console.log(`Max drawdown:      ${Number(balance.max_drawdown_percent).toFixed(2)}%`);
  console.log('─────────────────────────────────────────────');
  console.log('(Detailed report — win rate, profit factor, equity curve — comes in step 3)');

  await closePgDb();
}

main().catch(err => {
  console.error('[run_backtest] fatal:', err);
  process.exit(1);
});
