/**
 * Parse + validate `npm run strategy:set -- <strategy_id> key=value ...` (pure).
 * Only whitelisted keys are accepted; each is converted to the stored field.
 */

const HOUR_MS = 3_600_000;
const KNOWN_SIGNAL_TYPES = ['extreme_ob', 'volume_spike', 'ema_cross_bull', 'ema_cross_bear', 'rsi_oversold', 'rsi_overbought', 'funding_extreme'];

const num = (v) => {
  if (!/^-?\d+(\.\d+)?$/.test(String(v).trim())) throw new Error(`"${v}" is not a number`);
  return Number(v);
};
const int = (v) => {
  const n = num(v);
  if (!Number.isInteger(n)) throw new Error(`"${v}" is not an integer`);
  return n;
};
const between = (lo, hi, parse = num) => (v) => {
  const n = parse(v);
  if (n < lo || n > hi) throw new Error(`${n} is outside ${lo}..${hi}`);
  return n;
};
const bool = (v) => {
  const s = String(v).trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  throw new Error(`"${v}" must be true or false`);
};

/** key → { field, parse, unit? } */
export const STRATEGY_KEYS = {
  max_hold_hours: { field: 'max_hold_ms', parse: v => Math.round(between(0.25, 168)(v) * HOUR_MS), hint: '0.25..168 hours' },
  max_hold_ms: { field: 'max_hold_ms', parse: between(15 * 60_000, 168 * HOUR_MS, int), hint: '900000..604800000 ms' },
  leverage: { field: 'leverage', parse: between(1, 20, int), hint: 'integer 1..20' },
  max_open_positions: { field: 'max_open_positions', parse: between(1, 10, int), hint: 'integer 1..10' },
  tp_percent: { field: 'tp_percent', parse: between(0.1, 50), hint: '0.1..50 (fallback TP %)' },
  sl_percent: { field: 'sl_percent', parse: between(-50, -0.1), hint: '-50..-0.1 (fallback SL %, negative)' },
  use_llm: { field: 'use_llm', parse: bool, hint: 'true|false' },
  llm_shadow: { field: 'llm_shadow', parse: bool, hint: 'true|false' },
  llm_min_confidence: { field: 'llm_min_confidence', parse: between(0, 100, int), hint: 'integer 0..100' },
  trailing_enabled: { field: 'trailing_enabled', parse: bool, hint: 'true|false' },
  trailing_percent: { field: 'trailing_percent', parse: between(0, 50), hint: '0..50' },
  min_volume_24h_usdt: { field: 'min_volume_24h_usdt', parse: between(0, 1e12), hint: '>= 0' },
  min_open_interest_usdt: { field: 'min_open_interest_usdt', parse: between(0, 1e12), hint: '>= 0' },
  signal_types: {
    field: 'signal_types',
    parse: (v) => {
      const types = [...new Set(String(v).split(',').map(s => s.trim()).filter(Boolean))];
      const unknown = types.filter(t => !KNOWN_SIGNAL_TYPES.includes(t));
      if (!types.length) throw new Error('empty list');
      if (unknown.length) throw new Error(`unknown signal type(s): ${unknown.join(', ')}`);
      return types.join(',');
    },
    hint: `comma list of ${KNOWN_SIGNAL_TYPES.join('|')}`,
  },
};

/**
 * @param {string[]} argv - e.g. ['extreme_ob', 'max_hold_hours=4', '--dry-run']
 * @returns {{ strategyId: string, patch: object, dryRun: boolean, create: boolean }}
 * @throws {Error} with every problem listed
 */
export function parseStrategyArgs(argv) {
  const flags = argv.filter(a => a.startsWith('--'));
  const rest = argv.filter(a => !a.startsWith('--'));
  const unknownFlags = flags.filter(f => !['--dry-run', '--create'].includes(f));
  const [strategyId, ...pairs] = rest;
  const errors = [];

  if (unknownFlags.length) errors.push(`unknown flag(s): ${unknownFlags.join(', ')}`);
  if (!strategyId || !/^[a-z][a-z0-9_]{0,48}$/.test(strategyId)) errors.push(`strategy id "${strategyId ?? ''}" must be lowercase letters, digits, _`);
  if (!pairs.length) errors.push('nothing to set — pass key=value');

  const patch = {};
  const fieldSource = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) { errors.push(`"${pair}" is not key=value`); continue; }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    const spec = STRATEGY_KEYS[key];
    if (!spec) { errors.push(`unknown key "${key}" (allowed: ${Object.keys(STRATEGY_KEYS).join(', ')})`); continue; }
    if (fieldSource[spec.field]) { errors.push(`"${key}" and "${fieldSource[spec.field]}" both set ${spec.field}`); continue; }
    try {
      patch[spec.field] = spec.parse(value);
      fieldSource[spec.field] = key;
    } catch (err) {
      errors.push(`${key}: ${err.message} (expected ${spec.hint})`);
    }
  }

  if (errors.length) throw new Error(errors.join('\n'));
  return { strategyId, patch, dryRun: flags.includes('--dry-run'), create: flags.includes('--create') };
}

/** Fields whose value actually changes, for the before/after display. */
export function diffPatch(before, patch) {
  return Object.entries(patch).map(([field, after]) => ({
    field, before: before?.[field], after, changed: before?.[field] !== after,
  }));
}

export function formatHours(ms) {
  return typeof ms === 'number' ? `${ms} ms (${+(ms / HOUR_MS).toFixed(4)}h)` : String(ms);
}
