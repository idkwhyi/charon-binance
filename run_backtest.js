#!/usr/bin/env node
import 'dotenv/config';
import { initPgDb, closePgDb } from './src/db/pg-connection.js';
import { runBacktest } from './src/backtest/runner.js';
import { buildBacktestReport, printBacktestReport } from './src/backtest/report.js';
import { prepareDynamicUniverse } from './src/backtest/dynamicUniverse.js';
import { fetchExchangeInfoAll } from './src/enrichment/binance.js';
import { WATCHLIST, UNIVERSE_EXCLUDE_SYMBOLS } from './src/config.js';
import { universeRules } from './src/universe/rules.js';
import { isEntryPoint } from './src/entry.js';

/**
 * CLI runner + reporter for the historical backtest engine.
 *
 * Run a new backtest:
 *   node run_backtest.js --symbols BTCUSDT,ETHUSDT --strategy scalp \
 *     --from 2026-01-01 --to 2026-06-01 [--balance 1000] [--label "my run"]
 *     [--oi-missing reject|ignore]
 *
 * Dynamic (point-in-time) universe instead of a fixed symbol list:
 *   node run_backtest.js --universe dynamic --strategy scalp --from ... --to ... \
 *     [--symbols CORE1,CORE2] [--unknown-underlying reject|coin]
 *
 * --universe fixed (default): trade exactly --symbols.
 * --universe dynamic: at every 15m close, the live universe rules
 *   (src/universe/rules.js) over every USDⓈ-M perpetual incl. delisted ones;
 *   core symbols (--symbols, else env WATCHLIST) are always in.
 *   15m candles are cached for all symbols; 1h/15m/1m only while in the universe.
 * --unknown-underlying: symbols missing from today's exchangeInfo (e.g.
 *   delisted) have no underlyingType: treat them as COIN (default) or reject
 *   them. Known non-crypto ones go in UNIVERSE_EXCLUDE_SYMBOLS (.env), which
 *   applies to live and backtest alike.
 * --oi-missing: what the strategy's min_open_interest_usdt filter does when the
 *   data.binance.vision metrics archive has no OI for that symbol/time —
 *   reject the candidate (default) or ignore the filter.
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
  '  node run_backtest.js --universe dynamic --strategy scalp --from 2026-01-01 --to 2026-02-01 [--symbols CORE1,CORE2] [--unknown-underlying reject|coin] [--oi-missing reject|ignore]\n' +
  '  node run_backtest.js --symbols BTCUSDT,ETHUSDT --strategy scalp --from 2026-01-01 --to 2026-06-01 [--balance 1000] [--label "my run"] [--oi-missing reject|ignore]\n' +
  '  node run_backtest.js --report <runId>';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await initPgDb();

  let runId;
  if (args.report) {
    runId = Number(args.report);
  } else {
    const mode = args.universe || 'fixed';
    const unknownUnderlying = args['unknown-underlying'] || 'coin';
    if (!['fixed', 'dynamic'].includes(mode) || !['reject', 'coin'].includes(unknownUnderlying) || !args.strategy || !args.from || !args.to || (mode === 'fixed' && !args.symbols)) {
      console.error(USAGE);
      process.exit(1);
    }

    const symbols = args.symbols ? args.symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : null;
    const dateFromMs = new Date(args.from).getTime();
    const dateToMs = new Date(args.to).getTime();

    if (!Number.isFinite(dateFromMs) || !Number.isFinite(dateToMs) || dateFromMs >= dateToMs) {
      console.error('Invalid --from/--to date range.');
      process.exit(1);
    }

    let dynamic = {};
    if (mode === 'dynamic') {
      const { timeline, fetchRangeFor } = await prepareDynamicUniverse({
        dateFromMs, dateToMs,
        core: symbols || WATCHLIST,
        exchangeInfoSymbols: await fetchExchangeInfoAll(),
        unknownUnderlying,
        rules: universeRules({ excludeSymbols: UNIVERSE_EXCLUDE_SYMBOLS }),
      });
      dynamic = { universe: timeline, fetchRangeFor };
    }

    runId = await runBacktest({
      label: args.label || `${args.strategy}${mode === 'dynamic' ? '_dynamic' : ''}_${args.from}_${args.to}`,
      strategyId: args.strategy,
      symbols,
      dateFromMs,
      dateToMs,
      startingBalance: Number(args.balance || 1000),
      oiMissing: args['oi-missing'] || 'reject',
      ...dynamic,
    });
  }

  const report = await buildBacktestReport(runId);
  printBacktestReport(report);

  await closePgDb();
}

// Only when executed directly: importing this file (tests) must not touch the DB or network
if (isEntryPoint(import.meta.url)) main().catch(err => {
  console.error('[run_backtest] fatal:', err);
  process.exit(1);
});
