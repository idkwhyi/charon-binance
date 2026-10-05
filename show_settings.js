#!/usr/bin/env node
/**
 * Print every setting the bot will run with — read-only.
 *
 *   npm run settings:show
 *
 * The DB session is opened with default_transaction_read_only=on, so any
 * write is rejected by PostgreSQL itself. Effective values are read through
 * the same helpers the bot uses (activeStrategy, boolSetting, ...), so code
 * defaults merged with DB rows show exactly as the bot sees them. Secrets
 * are never printed, only whether they are set.
 */

import pg from 'pg';
import * as config from './src/config.js';
import { setPool } from './src/db/pg-connection.js';
import { activeStrategy, getSetting, boolSetting } from './src/db/settings.js';
import { getWatchlist } from './src/db/watchlist.js';
import { realizedPnlSince } from './src/db/positions.js';
import { shouldUseLlm } from './src/pipeline/candidateSelector.js';
import { utcDayStartMs, dailyLossStatus } from './src/pipeline/riskControls.js';
import { buildSettingsReport, formatSettingsReport, missingSchema, EXPECTED_SCHEMA } from './src/tools/settingsReport.js';
import { isEntryPoint } from './src/entry.js';

async function main() {
  const pool = new pg.Pool({
    host: config.PG_HOST, port: config.PG_PORT, database: config.PG_DATABASE,
    user: config.PG_USER, password: config.PG_PASSWORD,
    max: 2, connectionTimeoutMillis: 5000,
    options: '-c default_transaction_read_only=on',
  });
  setPool(pool);

  const errors = [];
  const tryRead = async (what, fn, fallback = null) => {
    try { return await fn(); } catch (err) { errors.push(`${what}: ${err.message}`); return fallback; }
  };

  await pool.query('SELECT 1'); // fail fast with a clear error if the DB is unreachable

  const activeStrategyRaw = await tryRead('active_strategy', () => getSetting('active_strategy'));
  const strat = await activeStrategy();
  const strategyRow = await tryRead(`strategy:${strat.id}`, () => getSetting(`strategy:${strat.id}`));
  const settings = {
    agentEnabledRaw: await tryRead('agent_enabled', () => getSetting('agent_enabled')),
    agentEnabled: await boolSetting('agent_enabled', true),
    entriesPausedRaw: await tryRead('entries_paused', () => getSetting('entries_paused')),
    entriesPaused: await boolSetting('entries_paused', false),
    llmMinConfidence: await tryRead('llm_min_confidence', () => getSetting('llm_min_confidence')),
  };

  const watchlist = await tryRead('watchlist', () => getWatchlist());

  const openPositions = await tryRead('open positions', async () => {
    const r = await pool.query("SELECT direction, execution_mode, COUNT(*)::int AS n FROM positions WHERE status = 'open' GROUP BY 1, 2");
    const out = { LONG: 0, SHORT: 0, byMode: {} };
    for (const row of r.rows) {
      out[row.direction] = (out[row.direction] || 0) + row.n;
      out.byMode[row.execution_mode] = (out.byMode[row.execution_mode] || 0) + row.n;
    }
    return out;
  });

  const virtualBalance = await tryRead('virtual balance', async () =>
    (await pool.query("SELECT * FROM virtual_balance WHERE execution_mode = 'dry_run' ORDER BY id DESC LIMIT 1")).rows[0] || null);

  const daily = config.TRADING_MODE === 'dry_run' && virtualBalance
    ? await tryRead('daily PnL', async () => {
        const realizedTodayUsdt = await realizedPnlSince(utcDayStartMs(Date.now()), 'dry_run');
        return { ...dailyLossStatus({ currentBalanceUsdt: Number(virtualBalance.balance_usdt), realizedTodayUsdt, limitPercent: config.DAILY_LOSS_LIMIT_PERCENT }), realizedTodayUsdt };
      })
    : null;

  const schemaMissing = await tryRead('schema', async () => {
    const r = await pool.query(
      'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1)',
      [Object.keys(EXPECTED_SCHEMA)]);
    const present = {};
    for (const { table_name: t, column_name: c } of r.rows) (present[t] ||= new Set()).add(c);
    return missingSchema(present);
  });

  const legacyLiqRows = await tryRead('legacy exit reasons', async () =>
    (await pool.query("SELECT COUNT(*)::int AS n FROM positions WHERE exit_reason = 'LIQUIDATION_GUARD'")).rows[0].n, 0);

  const report = buildSettingsReport({
    config, env: process.env, strat, strategyRow, activeStrategyRaw, settings,
    llmDecides: shouldUseLlm(config.LLM_DECISION_ENABLED, strat),
    extra: { watchlist, openPositions, virtualBalance, daily, missingSchema: schemaMissing, legacyLiqRows, errors },
  });
  console.log(formatSettingsReport(report));
  await pool.end();
}

// Only when executed directly: importing this file (tests) must not touch the DB or network
if (isEntryPoint(import.meta.url)) main().catch(err => {
  console.error(`[settings:show] failed: ${err.message}`);
  process.exit(1);
});
