import { db } from './connection.js';

export function activeStrategy() {
  const row = db.prepare("SELECT value FROM strategy_config WHERE key = 'active_strategy'").get();
  const id = row?.value || 'scalp';
  return strategyById(id);
}

export function strategyById(id) {
  const row = db.prepare("SELECT value FROM strategy_config WHERE key = ?").get(`strategy:${id}`);
  if (!row) return defaultStrategy(id);
  try { return { ...defaultStrategy(id), ...JSON.parse(row.value), id }; }
  catch { return defaultStrategy(id); }
}

function defaultStrategy(id = 'scalp') {
  const base = {
    id,
    label: id,
    use_llm: true,
    leverage: 5,
    tp_percent: 2,
    sl_percent: -1.5,
    trailing_enabled: false,
    trailing_percent: 0,
    max_hold_ms: 4 * 60 * 60 * 1000,
    min_volume_spike_ratio: 3,
    min_open_interest_usdt: 10_000_000,
    max_open_positions: 3,
    llm_min_confidence: 70,
    signal_types: 'volume_spike,ema_cross_bull,ema_cross_bear',
  };

  // Strategy-specific overrides
  if (id === 'extreme_ob') {
    return {
      ...base,
      label: 'Extreme Order Block',
      use_llm: true,
      leverage: 5,
      tp_percent: 3,       // fallback only; OB meta overrides this
      sl_percent: -1.5,    // fallback only; OB meta overrides this
      max_open_positions: 2,
      llm_min_confidence: 65,
      signal_types: 'extreme_ob',
      min_volume_24h_usdt: 50_000_000,
      min_open_interest_usdt: 20_000_000,
    };
  }

  return base;
}

export function setStrategySetting(stratId, key, value) {
  const strat = strategyById(stratId);
  let parsed = value;
  if (!isNaN(Number(value))) parsed = Number(value);
  else if (value === 'true') parsed = true;
  else if (value === 'false') parsed = false;
  strat[key] = parsed;
  db.prepare("INSERT OR REPLACE INTO strategy_config (key, value) VALUES (?, ?)")
    .run(`strategy:${stratId}`, JSON.stringify(strat));
}

export function setActiveSetting(key, value) {
  db.prepare("INSERT OR REPLACE INTO strategy_config (key, value) VALUES (?, ?)").run(key, String(value));
}

export function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM strategy_config WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

export function numSetting(key, fallback = 0) {
  const v = getSetting(key);
  return v !== null ? Number(v) : fallback;
}

export function boolSetting(key, fallback = true) {
  const v = getSetting(key);
  if (v === null) return fallback;
  return v === 'true' || v === '1';
}

export function allStrategyIds() {
  const rows = db.prepare("SELECT key FROM strategy_config WHERE key LIKE 'strategy:%'").all();
  return rows.map(r => r.key.replace('strategy:', ''));
}
