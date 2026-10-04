#!/usr/bin/env node
/**
 * Set strategy fields in strategy_config (key strategy:<id>, JSONB value).
 *
 *   npm run strategy:set -- extreme_ob max_hold_hours=4
 *   npm run strategy:set -- extreme_ob leverage=3 max_open_positions=2 --dry-run
 *
 * Safe to re-run: only whitelisted keys (src/tools/strategyPatch.js), merged
 * into the existing row in one transaction (other fields untouched); if
 * nothing changes, nothing is written. --dry-run shows the change and rolls
 * back. --create allows creating a missing strategy row. The running bot
 * picks the change up within ~60s (strategy cache).
 */

import pg from 'pg';
import * as config from './src/config.js';
import { setPool, fromJsonb } from './src/db/pg-connection.js';
import { strategyById } from './src/db/settings.js';
import { parseStrategyArgs, diffPatch, formatHours, STRATEGY_KEYS } from './src/tools/strategyPatch.js';

const USAGE = `Usage: npm run strategy:set -- <strategy_id> key=value [key=value ...] [--dry-run] [--create]
Keys:\n${Object.entries(STRATEGY_KEYS).map(([k, s]) => `  ${k.padEnd(24)} ${s.hint}`).join('\n')}`;

const show = (field, v) => (field === 'max_hold_ms' ? formatHours(v) : JSON.stringify(v));

async function main() {
  let args;
  try {
    args = parseStrategyArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Invalid input:\n${err.message.split('\n').map(l => `  - ${l}`).join('\n')}\n\n${USAGE}`);
    process.exit(1);
  }
  const { strategyId, patch, dryRun, create } = args;
  const key = `strategy:${strategyId}`;

  const pool = new pg.Pool({
    host: config.PG_HOST, port: config.PG_PORT, database: config.PG_DATABASE,
    user: config.PG_USER, password: config.PG_PASSWORD, max: 2, connectionTimeoutMillis: 5000,
  });
  setPool(pool);
  const client = await pool.connect();
  try {
    const effectiveBefore = await strategyById(strategyId); // code defaults + DB row, as the bot sees it

    await client.query('BEGIN');
    const cur = await client.query('SELECT value FROM strategy_config WHERE key = $1 FOR UPDATE', [key]);
    const rowBefore = cur.rows.length ? fromJsonb(cur.rows[0].value) : null;
    if (!rowBefore && !create) {
      throw new Error(`${key} is not in strategy_config. Check the id, or pass --create to create it.`);
    }

    console.log(`Strategy ${strategyId} (strategy_config key '${key}')${dryRun ? '  [DRY RUN]' : ''}\n`);
    const diff = diffPatch(rowBefore, patch);
    for (const d of diff) {
      const effBefore = effectiveBefore[d.field];
      const source = rowBefore && Object.prototype.hasOwnProperty.call(rowBefore, d.field) ? 'db' : 'code default';
      console.log(`  ${d.field}`);
      console.log(`    before: ${show(d.field, effBefore)}  [${source}]`);
      console.log(`    after:  ${show(d.field, d.after)}${d.changed || source !== 'db' ? '' : '  (unchanged)'}`);
    }

    const needsWrite = !rowBefore || diff.some(d => d.changed);
    if (!needsWrite) {
      await client.query('ROLLBACK');
      console.log('\nAlready set — nothing written.');
      return;
    }

    // Warn about open positions an immediate max_hold change would close on the next monitor cycle
    if (patch.max_hold_ms !== undefined) {
      const r = await client.query(
        "SELECT COUNT(*)::int AS n FROM positions WHERE status = 'open' AND strategy_id = $1 AND opened_at_ms <= $2",
        [strategyId, Date.now() - patch.max_hold_ms]);
      if (r.rows[0].n > 0) console.log(`\n! ${r.rows[0].n} open ${strategyId} position(s) are already older than the new max hold and will exit (MAX_HOLD) on the next monitor cycle.`);
    }

    if (rowBefore) {
      await client.query('UPDATE strategy_config SET value = value || $2::jsonb WHERE key = $1', [key, JSON.stringify(patch)]);
    } else {
      await client.query('INSERT INTO strategy_config (key, value) VALUES ($1, $2::jsonb)', [key, JSON.stringify(patch)]);
    }
    const after = fromJsonb((await client.query('SELECT value FROM strategy_config WHERE key = $1', [key])).rows[0].value);

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('\nDry run — rolled back, nothing written.');
      return;
    }
    await client.query('COMMIT');

    console.log('\nStored now:');
    for (const field of Object.keys(patch)) console.log(`  ${field} = ${show(field, after[field])}`);
    console.log('\nNotes:');
    console.log('  - The running bot picks this up within ~60s (strategy cache).');
    console.log("  - 'npm run migrate' re-seeds strategy:extreme_ob and overwrites changes made here.");
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(`[strategy:set] failed: ${err.message}`);
  process.exit(1);
});
