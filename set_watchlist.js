#!/usr/bin/env node
/**
 * Replace the DB watchlist (strategy_config key 'watchlist:symbols', JSONB array).
 *
 *   npm run watchlist:set -- BTCUSDT,ETHUSDT,BNBUSDT
 *   npm run watchlist:set -- BTCUSDT,ETHUSDT --dry-run
 *
 * Safe to re-run: symbols are validated (format, duplicates, max size) and,
 * unless --no-verify, checked against Binance /fapi/v1/exchangeInfo as
 * TRADING USDT perpetuals (public endpoint, no API key). Writing the same
 * list again changes nothing. --dry-run shows the change and rolls back.
 */

import pg from 'pg';
import axios from 'axios';
import * as config from './src/config.js';
import { fromJsonb } from './src/db/pg-connection.js';
import { parseWatchlistArgs, untradableSymbols, listDiff, WATCHLIST_MAX } from './src/tools/watchlistInput.js';

const KEY = 'watchlist:symbols';
const USAGE = `Usage: npm run watchlist:set -- SYM1,SYM2,... [--dry-run] [--no-verify]   (USDT-M symbols, max ${WATCHLIST_MAX})`;

async function main() {
  let args;
  try {
    args = parseWatchlistArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Invalid input:\n${err.message.split('\n').map(l => `  - ${l}`).join('\n')}\n\n${USAGE}`);
    process.exit(1);
  }
  const { symbols, dryRun, verify } = args;

  if (verify) {
    const res = await axios.get(`${config.BINANCE_FUTURES_BASE_URL}/fapi/v1/exchangeInfo`, { timeout: 10_000 });
    const bad = untradableSymbols(symbols, res.data.symbols || []);
    if (bad.length) {
      console.error(`Not tradable as USDT-M perpetuals on Binance: ${bad.join(', ')}\n(use --no-verify to skip this check)`);
      process.exit(1);
    }
  }

  const pool = new pg.Pool({
    host: config.PG_HOST, port: config.PG_PORT, database: config.PG_DATABASE,
    user: config.PG_USER, password: config.PG_PASSWORD, max: 2, connectionTimeoutMillis: 5000,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT value FROM strategy_config WHERE key = $1 FOR UPDATE', [KEY]);
    const stored = cur.rows.length ? fromJsonb(cur.rows[0].value) : null;
    const storedList = Array.isArray(stored) ? stored : [];
    const effectiveBefore = storedList.length ? storedList : config.WATCHLIST; // same fallback as getWatchlist()

    console.log(`Watchlist (strategy_config key '${KEY}')${dryRun ? '  [DRY RUN]' : ''}\n`);
    console.log(`  before (${effectiveBefore.length}): ${effectiveBefore.join(', ')}  [${storedList.length ? 'db' : 'env WATCHLIST fallback'}]`);
    console.log(`  after  (${symbols.length}): ${symbols.join(', ')}`);
    const d = listDiff(effectiveBefore, symbols);
    if (d.added.length) console.log(`  + added:   ${d.added.join(', ')}`);
    if (d.removed.length) console.log(`  - removed: ${d.removed.join(', ')}`);

    if (listDiff(storedList, symbols).unchanged) {
      await client.query('ROLLBACK');
      console.log('\nAlready set — nothing written.');
      return;
    }

    if (d.removed.length) {
      const r = await client.query("SELECT symbol FROM positions WHERE status = 'open' AND symbol = ANY($1)", [d.removed]);
      if (r.rows.length) console.log(`\n! Open positions on removed symbols keep being monitored until they exit: ${r.rows.map(x => x.symbol).join(', ')}`);
    }

    await client.query(
      'INSERT INTO strategy_config (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [KEY, JSON.stringify(symbols)]);
    const after = fromJsonb((await client.query('SELECT value FROM strategy_config WHERE key = $1', [KEY])).rows[0].value);

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('\nDry run — rolled back, nothing written.');
      return;
    }
    await client.query('COMMIT');

    console.log(`\nStored now (${after.length}): ${after.join(', ')}`);
    console.log('\nNotes:');
    console.log('  - Restart the bot (or /watch, /unwatch) so the WebSocket subscribes to the new list; reads are cached ~60s.');
    if (config.TOP_GAINER_ENABLED) {
      console.log('  ! TOP_GAINER_ENABLED is true: the top-gainer refresh (at startup and every');
      console.log('    TOP_GAINER_REFRESH_MS) rebuilds this list as pinned + env WATCHLIST + gainers.');
      console.log('    Set TOP_GAINER_ENABLED=false in .env to keep exactly this list.');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(`[watchlist:set] failed: ${err.message}`);
  process.exit(1);
});
