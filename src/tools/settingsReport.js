import { validateStrictContinuity } from '../signals/klineCache.js';

/**
 * Pure builder/formatter for `npm run settings:show` (show_settings.js).
 * Takes already-fetched values; no DB or network access here.
 */

/** Columns/tables the current code expects (migrations 004–007, 009). */
export const EXPECTED_SCHEMA = {
  positions: ['quantity', 'entry_mark_price', 'stop_loss_price', 'take_profit_price', 'risk_usdt',
    'exit_price_raw', 'entry_fee_usdt', 'exit_fee_usdt', 'slippage_usdt', 'pnl_r', 'last_candle_checked_ms'],
  signal_events: ['reason_code'],
  llm_shadow_decisions: ['agrees'],
  backtest_positions: ['risk_usdt', 'pnl_r'],
  backtest_runs: ['signal_outcomes_json'],
};

/** "table.column" entries from EXPECTED_SCHEMA missing in `presentColumns` ({ table: Set(columns) }). */
export function missingSchema(presentColumns) {
  const missing = [];
  for (const [table, cols] of Object.entries(EXPECTED_SCHEMA)) {
    const have = presentColumns[table] || new Set();
    for (const col of cols) if (!have.has(col)) missing.push(`${table}.${col}`);
  }
  return missing;
}

const fmtMs = ms => {
  const n = Number(ms);
  if (!(n > 0)) return 'off';
  return n % 3_600_000 === 0 ? `${n / 3_600_000}h` : `${Math.round(n / 60_000)}m`;
};
const yesNo = v => (v ? 'yes' : 'no');

/**
 * @param {object} p
 * @param {object} p.config - src/config.js exports
 * @param {object} p.env - process.env (only used to tell env-set from default)
 * @param {object} p.strat - effective active strategy (defaults merged with DB)
 * @param {object|null} p.strategyRow - raw strategy:<id> value from DB (null = not in DB)
 * @param {string|null} p.activeStrategyRaw - raw active_strategy setting (null = not set)
 * @param {object} p.settings - { agentEnabled, entriesPaused, llmMinConfidence (raw|null) }
 * @param {boolean} p.llmDecides - shouldUseLlm(LLM_DECISION_ENABLED, strat)
 * @param {object} p.extra - optional { watchlist, openPositions, virtualBalance, daily, missingSchema, legacyLiqRows, errors }
 */
export function buildSettingsReport({ config, env, strat, strategyRow, activeStrategyRaw, settings, llmDecides, extra = {} }) {
  const fromEnv = key => (env[key] !== undefined && env[key] !== '' ? 'env' : 'default');
  const fromDb = key => (strategyRow && Object.prototype.hasOwnProperty.call(strategyRow, key) ? 'db' : 'default');
  const s = (label, key, fmt = v => v) => [label, fmt(strat[key]), fromDb(key)];

  const sections = [
    {
      title: 'Mode & decision path',
      rows: [
        ['TRADING_MODE', config.TRADING_MODE, fromEnv('TRADING_MODE')],
        ['Active strategy', strat.id, activeStrategyRaw ? 'db' : 'default'],
        ['Strategy stored in DB', yesNo(!!strategyRow), strategyRow ? 'db' : '—'],
        ['agent_enabled', yesNo(settings.agentEnabled), settings.agentEnabledRaw == null ? 'default' : 'db'],
        ['entries_paused (/pause)', yesNo(settings.entriesPaused), settings.entriesPausedRaw == null ? 'default' : 'db'],
        ['LLM_DECISION_ENABLED', yesNo(config.LLM_DECISION_ENABLED), fromEnv('LLM_DECISION_ENABLED')],
        s('use_llm', 'use_llm', yesNo),
        ['→ LLM decides trades', yesNo(llmDecides), 'derived'],
        s('llm_shadow', 'llm_shadow', yesNo),
        ['ENABLE_LLM / LLM key set', `${yesNo(config.ENABLE_LLM)} / ${yesNo(!!config.LLM_API_KEY)}`, fromEnv('ENABLE_LLM')],
        ['llm_min_confidence', settings.llmMinConfidence ?? strat.llm_min_confidence, settings.llmMinConfidence == null ? 'strategy' : 'db'],
      ],
    },
    {
      title: 'Risk',
      rows: [
        ['RISK_PERCENT_PER_TRADE', `${config.RISK_PERCENT_PER_TRADE}%`, fromEnv('RISK_PERCENT_PER_TRADE')],
        ['MAX_MARGIN_PERCENT_PER_TRADE', `${config.MAX_MARGIN_PERCENT_PER_TRADE}%`, fromEnv('MAX_MARGIN_PERCENT_PER_TRADE')],
        ['DAILY_LOSS_LIMIT_PERCENT', `-${config.DAILY_LOSS_LIMIT_PERCENT}%`, fromEnv('DAILY_LOSS_LIMIT_PERCENT')],
        ['MAX_SAME_DIRECTION_POSITIONS', config.MAX_SAME_DIRECTION_POSITIONS, fromEnv('MAX_SAME_DIRECTION_POSITIONS')],
        s('max_open_positions', 'max_open_positions'),
        s('leverage', 'leverage', v => `${v}x`),
        ['MARGIN_TYPE', config.MARGIN_TYPE, fromEnv('MARGIN_TYPE')],
        s('max_hold', 'max_hold_ms', fmtMs),
        s('tp_percent (fallback)', 'tp_percent', v => `${v}%`),
        s('sl_percent (fallback)', 'sl_percent', v => `${v}%`),
        s('trailing_enabled', 'trailing_enabled', yesNo),
      ],
    },
    {
      title: 'Signals & filters',
      rows: [
        s('signal_types', 'signal_types'),
        s('min_volume_24h_usdt', 'min_volume_24h_usdt', v => v ?? 'none'),
        s('min_open_interest_usdt', 'min_open_interest_usdt', v => v ?? 'none'),
        ['Watchlist', extra.watchlist ? `${extra.watchlist.length}: ${extra.watchlist.join(', ')}` : 'unavailable', 'db/env'],
        ['TOP_GAINER_ENABLED', yesNo(config.TOP_GAINER_ENABLED), fromEnv('TOP_GAINER_ENABLED')],
        ['UNIVERSE_EXCLUDE_SYMBOLS', config.UNIVERSE_EXCLUDE_SYMBOLS?.length ? config.UNIVERSE_EXCLUDE_SYMBOLS.join(', ') : 'none', fromEnv('UNIVERSE_EXCLUDE_SYMBOLS')],
        ['KLINE_STRICT_CONTINUITY_CANDLES_15M', config.KLINE_STRICT_CONTINUITY_CANDLES_15M, fromEnv('KLINE_STRICT_CONTINUITY_CANDLES_15M')],
        ['KLINE_STRICT_CONTINUITY_CANDLES_1H', config.KLINE_STRICT_CONTINUITY_CANDLES_1H, fromEnv('KLINE_STRICT_CONTINUITY_CANDLES_1H')],
      ],
    },
    {
      title: 'Simulation (dry-run + backtest)',
      rows: [
        ['SIM_SLIPPAGE_PERCENT', `${config.SIM_SLIPPAGE_PERCENT}% / side`, fromEnv('SIM_SLIPPAGE_PERCENT')],
        ['SIM_TAKER_FEE_PERCENT', `${config.SIM_TAKER_FEE_PERCENT}% / side`, fromEnv('SIM_TAKER_FEE_PERCENT')],
      ],
    },
  ];

  const state = [];
  if (extra.virtualBalance) {
    const vb = extra.virtualBalance;
    state.push(['Virtual balance', `${Number(vb.balance_usdt).toFixed(2)} USDT (available ${Number(vb.available_balance).toFixed(2)})`, 'db']);
  }
  if (extra.daily) {
    state.push(['Today realized (UTC)', `${extra.daily.realizedTodayUsdt.toFixed(2)} USDT (${extra.daily.pnlPercent.toFixed(2)}%)${extra.daily.breached ? ' — LIMIT HIT' : ''}`, 'db']);
  }
  if (extra.openPositions) {
    const { LONG = 0, SHORT = 0, byMode = {} } = extra.openPositions;
    const modes = Object.entries(byMode).map(([m, n]) => `${m}: ${n}`).join(', ') || 'none';
    state.push(['Open positions', `${LONG + SHORT} (LONG ${LONG} / SHORT ${SHORT}) — ${modes}`, 'db']);
  }
  if (state.length) sections.push({ title: 'Current state', rows: state });

  const warnings = [];
  if (config.TRADING_MODE !== 'dry_run') warnings.push(`TRADING_MODE is '${config.TRADING_MODE}', not dry_run — real orders possible.`);
  if (config.TRADING_MODE !== 'dry_run' && (!config.BINANCE_API_KEY || !config.BINANCE_API_SECRET)) warnings.push('Binance API key/secret missing for a non-dry_run mode.');
  if (llmDecides) warnings.push('LLM is in the trade decision path (LLM_DECISION_ENABLED=true and use_llm=true).');
  if (!settings.agentEnabled) warnings.push('agent_enabled is false — no entries will open.');
  if (settings.entriesPaused) warnings.push('entries_paused is true — no entries until /resume.');
  if (!strategyRow) warnings.push(`Strategy '${strat.id}' is not stored in DB — code defaults are in effect.`);
  if (!activeStrategyRaw) warnings.push(`active_strategy is not set in DB — falling back to '${strat.id}'.`);
  if (!String(strat.signal_types || '').split(',').map(x => x.trim()).includes('extreme_ob')) {
    warnings.push(`signal_types '${strat.signal_types}' does not include extreme_ob.`);
  }
  if (config.RISK_PERCENT_PER_TRADE > 1) warnings.push(`RISK_PERCENT_PER_TRADE is ${config.RISK_PERCENT_PER_TRADE}% (> 1%).`);
  if (strat.trailing_enabled) warnings.push('trailing_enabled is true — trailing is not simulated in dry-run/backtest.');
  if (extra.missingSchema?.length) warnings.push(`DB schema is behind the code — run \`npm run migrate\`. Missing: ${extra.missingSchema.join(', ')}`);
  if (extra.legacyLiqRows > 0) warnings.push(`${extra.legacyLiqRows} row(s) still use exit reason LIQUIDATION_GUARD (migration 008).`);
  if (extra.daily?.breached) warnings.push('Daily loss limit is currently hit — no entries until 00:00 UTC.');
  try {
    validateStrictContinuity({ '15m': config.KLINE_STRICT_CONTINUITY_CANDLES_15M, '1h': config.KLINE_STRICT_CONTINUITY_CANDLES_1H });
  } catch (err) {
    warnings.push(`${err.message} — the bot and backtest will refuse to start.`);
  }
  for (const e of extra.errors || []) warnings.push(`Could not read ${e}`);

  return { sections, warnings };
}

export function formatSettingsReport({ sections, warnings }) {
  const lines = ['Charon — active settings (read-only)', ''];
  for (const sec of sections) {
    lines.push(`== ${sec.title} ==`);
    const w = Math.max(...sec.rows.map(r => r[0].length));
    for (const [label, value, source] of sec.rows) {
      lines.push(`  ${label.padEnd(w)}  ${String(value)}${source ? `  [${source}]` : ''}`);
    }
    lines.push('');
  }
  lines.push(warnings.length ? `== Warnings (${warnings.length}) ==` : '== Warnings: none ==');
  for (const wn of warnings) lines.push(`  ! ${wn}`);
  return lines.join('\n');
}
