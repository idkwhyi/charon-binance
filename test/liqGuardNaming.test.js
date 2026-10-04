import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function files(dir, exts) {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p, exts);
    return exts.some(e => p.endsWith(e)) ? [p] : [];
  });
}

test('code and reports only use LIQ_GUARD', () => {
  // The old name may only appear as a legacy-data check (show_settings / settingsReport),
  // never as an exit reason that is set, compared against, or reported.
  const legacyCheckOnly = new Set(['src/tools/settingsReport.js', 'show_settings.js']);
  const offenders = [...files('src', ['.js']), 'view_performance.js', 'run_backtest.js', 'show_settings.js']
    .filter(f => !legacyCheckOnly.has(f) && readFileSync(f, 'utf8').includes('LIQUIDATION_GUARD'));
  assert.deepEqual(offenders, []);
});

test('migration 008 renames the old value in every table that stores an exit reason', () => {
  const sql = readFileSync('migrations/008_rename_liq_guard.sql', 'utf8');
  // every table with an exit_reason column in the schema must be covered
  const schema = files('migrations', ['.sql']).filter(f => !f.endsWith('008_rename_liq_guard.sql'))
    .map(f => readFileSync(f, 'utf8')).join('\n');
  const tablesWithExitReason = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\);/g)]
    .filter(([, , body]) => /\bexit_reason\b/.test(body))
    .map(([, name]) => name);
  assert.ok(tablesWithExitReason.length >= 3);
  for (const t of tablesWithExitReason) {
    assert.match(sql, new RegExp(`UPDATE ${t}\\s+SET exit_reason = 'LIQ_GUARD' WHERE exit_reason = 'LIQUIDATION_GUARD'`), t);
  }
  assert.match(sql, /UPDATE trades\s+SET reason\s+= 'LIQ_GUARD' WHERE reason\s+= 'LIQUIDATION_GUARD'/);
});
