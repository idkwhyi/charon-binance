import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSettingsReport, formatSettingsReport, missingSchema, EXPECTED_SCHEMA } from '../src/tools/settingsReport.js';

const baseConfig = {
  TRADING_MODE: 'dry_run', LLM_DECISION_ENABLED: false, ENABLE_LLM: true, LLM_API_KEY: 'sk-SECRET-llm',
  BINANCE_API_KEY: 'BIN-SECRET-key', BINANCE_API_SECRET: 'BIN-SECRET-secret', PG_PASSWORD: 'pg-SECRET',
  RISK_PERCENT_PER_TRADE: 1, MAX_MARGIN_PERCENT_PER_TRADE: 50, DAILY_LOSS_LIMIT_PERCENT: 3,
  MAX_SAME_DIRECTION_POSITIONS: 2, MARGIN_TYPE: 'ISOLATED', TOP_GAINER_ENABLED: true,
  SIM_SLIPPAGE_PERCENT: 0.03, SIM_TAKER_FEE_PERCENT: 0.05,
  KLINE_STRICT_CONTINUITY_CANDLES_15M: 20, KLINE_STRICT_CONTINUITY_CANDLES_1H: 6,
};
const strat = {
  id: 'extreme_ob', use_llm: false, llm_shadow: false, leverage: 5, max_open_positions: 2, max_hold_ms: 4 * 3_600_000,
  tp_percent: 3, sl_percent: -1.5, trailing_enabled: false, signal_types: 'extreme_ob',
  min_volume_24h_usdt: 50_000_000, min_open_interest_usdt: 20_000_000, llm_min_confidence: 65,
};
const settings = { agentEnabled: true, agentEnabledRaw: null, entriesPaused: false, entriesPausedRaw: null, llmMinConfidence: null };
const build = (over = {}) => buildSettingsReport({
  config: baseConfig, env: {}, strat, strategyRow: { leverage: 5 }, activeStrategyRaw: 'extreme_ob', settings, llmDecides: false,
  ...over,
});
const row = (report, label) => report.sections.flatMap(s => s.rows).find(r => r[0] === label);

test('a clean dry-run setup has no warnings and shows where values come from', () => {
  const r = build();
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(row(r, 'leverage'), ['leverage', '5x', 'db']);
  assert.deepEqual(row(r, 'max_hold'), ['max_hold', '4h', 'default']);
  assert.deepEqual(row(r, 'RISK_PERCENT_PER_TRADE'), ['RISK_PERCENT_PER_TRADE', '1%', 'default']);
  assert.equal(build({ env: { RISK_PERCENT_PER_TRADE: '1' } }).sections[1].rows[0][2], 'env');
  assert.equal(row(r, '→ LLM decides trades')[1], 'no');
});

test('flags risky or surprising settings', () => {
  const r = build({
    config: { ...baseConfig, TRADING_MODE: 'live', RISK_PERCENT_PER_TRADE: 2 },
    strat: { ...strat, signal_types: 'volume_spike', trailing_enabled: true },
    strategyRow: null, activeStrategyRaw: null, llmDecides: true,
    settings: { ...settings, agentEnabled: false, entriesPaused: true },
    extra: { missingSchema: ['positions.quantity'], legacyLiqRows: 2, daily: { breached: true, pnlPercent: -3.2, realizedTodayUsdt: -32 }, errors: ['watchlist: boom'] },
  });
  const all = r.warnings.join('\n');
  for (const needle of ["'live'", 'LLM is in the trade decision path', 'agent_enabled is false', 'entries_paused',
    'not stored in DB', 'active_strategy is not set', 'does not include extreme_ob', '(> 1%)', 'trailing',
    'npm run migrate', 'LIQUIDATION_GUARD', 'Daily loss limit', 'Could not read watchlist']) {
    assert.ok(all.includes(needle), `missing warning: ${needle}`);
  }
});

test('an invalid strict-continuity N is flagged', () => {
  const r = build({ config: { ...baseConfig, KLINE_STRICT_CONTINUITY_CANDLES_1H: 0 } });
  assert.ok(r.warnings.some(w => w.includes('KLINE_STRICT_CONTINUITY_CANDLES_1H=0') && w.includes('refuse to start')));
  assert.deepEqual(row(r, 'KLINE_STRICT_CONTINUITY_CANDLES_15M'), ['KLINE_STRICT_CONTINUITY_CANDLES_15M', 20, 'default']);
});

test('secrets are never printed, only whether they are set', () => {
  const text = formatSettingsReport(build({ extra: { watchlist: ['BTCUSDT'] } }));
  assert.ok(!/SECRET/.test(text), 'secret value leaked');
  assert.match(text, /LLM key set\s+yes \/ yes/);
});

test('missingSchema lists expected columns not present in the DB', () => {
  const allPresent = Object.fromEntries(Object.entries(EXPECTED_SCHEMA).map(([t, cols]) => [t, new Set(cols)]));
  assert.deepEqual(missingSchema(allPresent), []);
  const missing = missingSchema({ positions: new Set(['quantity']) });
  assert.ok(missing.includes('positions.pnl_r'));
  assert.ok(missing.includes('signal_events.reason_code'));
  assert.ok(!missing.includes('positions.quantity'));
});

test('the script opens a read-only DB session', () => {
  const src = readFileSync('show_settings.js', 'utf8');
  assert.match(src, /default_transaction_read_only=on/);
  assert.ok(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP)\b/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'no write SQL in the script');
});

test('.env variables the code no longer reads are flagged (retired TOP_GAINER_* with a hint)', async () => {
  const { envVarsInSource, envVarsReadByCode, unusedEnvVars } = await import('../src/tools/envUsage.js');
  assert.deepEqual(envVarsInSource("a = process.env.FOO_1 || process.env['BAR'];"), ['FOO_1', 'BAR']);

  const read = envVarsReadByCode(process.cwd());
  for (const v of ['TOP_GAINER_ENABLED', 'UNIVERSE_EXCLUDE_SYMBOLS', 'PG_HOST', 'BACKTEST_CACHE_DIR']) assert.ok(read.has(v), v);
  for (const v of ['TOP_GAINER_COUNT', 'TOP_GAINER_MIN_VOLUME_USDT', 'TOP_GAINER_REFRESH_MS']) assert.ok(!read.has(v), v);

  const unused = unusedEnvVars(['PG_HOST', 'TOP_GAINER_COUNT', 'TOP_GAINER_REFRESH_MS', 'MY_TYPO_VAR', 'NODE_ENV'], read);
  assert.deepEqual(unused.map(u => u.name), ['MY_TYPO_VAR', 'TOP_GAINER_COUNT', 'TOP_GAINER_REFRESH_MS']);
  assert.match(unused[1].hint, /src\/universe\/rules\.js/);

  const r = build({ extra: { unusedEnv: unused } });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /\.env sets variable\(s\) the code no longer reads.*MY_TYPO_VAR.*TOP_GAINER_COUNT \(universe rules/);
  assert.deepEqual(build().warnings, [], 'nothing unused: no warning');
});

test('every variable in .env.example is read by the code (none stale)', async () => {
  const { readFileSync } = await import('node:fs');
  const dotenv = (await import('dotenv')).default;
  const { envVarsReadByCode, unusedEnvVars } = await import('../src/tools/envUsage.js');
  assert.deepEqual(unusedEnvVars(Object.keys(dotenv.parse(readFileSync('.env.example'))), envVarsReadByCode(process.cwd())), []);
});
