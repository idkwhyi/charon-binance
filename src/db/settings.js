import { query as pgQuery } from './pg-connection.js';

// Cache for frequently accessed settings
let strategyCache = new Map();
let cacheExpiry = 0;

async function ensureStrategyCache() {
  if (Date.now() < cacheExpiry) return;
  
  try {
    const result = await pgQuery("SELECT key, value FROM strategy_config WHERE key LIKE 'strategy:%'");
    strategyCache.clear();
    for (const row of result.rows) {
      const id = row.key.replace('strategy:', '');
      // pg already decodes JSONB columns into JS objects — don't re-parse
      strategyCache.set(id, row.value);
    }
    cacheExpiry = Date.now() + 60000; // Cache for 1 minute
  } catch (err) {
    console.error('[settings] cache failed:', err.message);
  }
}

export async function activeStrategy() {
  try {
    const result = await pgQuery("SELECT value FROM strategy_config WHERE key = 'active_strategy'");
    const id = result.rows[0]?.value || 'scalp';
    return strategyById(id);
  } catch {
    return strategyById('scalp');
  }
}

export async function strategyById(id) {
  try {
    await ensureStrategyCache();
    if (strategyCache.has(id)) {
      return { ...defaultStrategy(id), ...strategyCache.get(id), id };
    }
    
    const result = await pgQuery("SELECT value FROM strategy_config WHERE key = $1", [`strategy:${id}`]);
    if (result.rows.length === 0) return defaultStrategy(id);

    // pg already decodes JSONB columns into JS objects — don't re-parse
    return { ...defaultStrategy(id), ...result.rows[0].value, id };
  } catch {
    return defaultStrategy(id);
  }
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

export async function setStrategySetting(stratId, key, value) {
  const strat = await strategyById(stratId);
  let parsed = value;
  if (!isNaN(Number(value))) parsed = Number(value);
  else if (value === 'true') parsed = true;
  else if (value === 'false') parsed = false;
  strat[key] = parsed;
  
  try {
    await pgQuery(
      "INSERT INTO strategy_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [`strategy:${stratId}`, JSON.stringify(strat)]
    );
    strategyCache.delete(stratId);
    cacheExpiry = 0; // Invalidate cache
  } catch (err) {
    console.error('[settings] setStrategySetting failed:', err.message);
  }
}

export async function setActiveSetting(key, value) {
  try {
    await pgQuery(
      "INSERT INTO strategy_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [key, String(value)]
    );
  } catch (err) {
    console.error('[settings] setActiveSetting failed:', err.message);
  }
}

export async function getSetting(key, fallback = null) {
  try {
    const result = await pgQuery("SELECT value FROM strategy_config WHERE key = $1", [key]);
    return result.rows[0]?.value || fallback;
  } catch {
    return fallback;
  }
}

export async function numSetting(key, fallback = 0) {
  const v = await getSetting(key);
  return v !== null ? Number(v) : fallback;
}

export async function boolSetting(key, fallback = true) {
  const v = await getSetting(key);
  if (v === null) return fallback;
  return v === 'true' || v === '1';
}

export async function allStrategyIds() {
  try {
    await ensureStrategyCache();
    return Array.from(strategyCache.keys());
  } catch {
    return [];
  }
}
