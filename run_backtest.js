#!/usr/bin/env node
import 'dotenv/config';
import { initPgDb, closePgDb } from './src/db/pg-connection.js';
import { runBacktest } from './src/backtest/runner.js';
import { buildBacktestReport, printBacktestReport } from './src/backtest/report.js';

/**
 * CLI runner + reporter for the historical backtest engine.
 *
 * Run a new backtest:
 *   node run_backtest.js --symbols BTCUSDT,ETHUSDT --strategy scalp \
 *     --from 2026-01-01 --to 2026-06-01 [--balance 1000] [--fee 0.04] [--slippage 0.02] [--label "my run"]
 *
 * Re-print the report for a past run without re-running it:
 *   node run_backtest.js --report 3
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

const USAGE = 'Usage:\n' +
  '  node run_backtest.js --symbols BTCUSDT,ETHUSDT --strategy scalp --from 2026-01-01 --to 2026-06-01 [--balance 1000] [--fee 0.04] [--slippage 0.02] [--label "my run"]\n' +
  '  node run_backtest.js --report <runId>';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await initPgDb();

  let runId;
  if (args.report) {
    runId = Number(args.report);
  } else {
    if (!args.symbols || !args.strategy || !args.from || !args.to) {
      console.error(USAGE);
      process.exit(1);
    }

    const symbols = args.symbols.split(',').map(s => s.trim().toUpperCase());
    const dateFromMs = new Date(args.from).getTime();
    const dateToMs = new Date(args.to).getTime();

    if (!Number.isFinite(dateFromMs) || !Number.isFinite(dateToMs) || dateFromMs >= dateToMs) {
      console.error('Invalid --from/--to date range.');
      process.exit(1);
    }

    runId = await runBacktest({
      label: args.label || `${args.strategy}_${args.from}_${args.to}`,
      strategyId: args.strategy,
      symbols,
      dateFromMs,
      dateToMs,
      startingBalance: Number(args.balance || 1000),
      feePercent: Number(args.fee || 0.04),
      slippagePercent: Number(args.slippage || 0.02),
    });
  }

  const report = await buildBacktestReport(runId);
  printBacktestReport(report);

  await closePgDb();
}

main().catch(err => {
  console.error('[run_backtest] fatal:', err);
  process.exit(1);
});
