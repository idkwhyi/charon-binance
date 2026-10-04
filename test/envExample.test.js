import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';

const example = dotenv.parse(readFileSync('.env.example'));

function jsFiles(dir) {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? jsFiles(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('.env.example lists every env var the code reads', () => {
  const files = [...jsFiles('src'), 'index.js', 'run_backtest.js', 'show_settings.js', 'view_performance.js', 'migrations/migrate.js'];
  const used = new Set(files.flatMap(f => [...readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z_]+)/g)].map(m => m[1])));
  const missing = [...used].filter(v => !(v in example));
  assert.deepEqual(missing, []);
});

test('new variables carry the code defaults and inline comments parse away', () => {
  assert.deepEqual(
    Object.fromEntries(['RISK_PERCENT_PER_TRADE', 'MAX_MARGIN_PERCENT_PER_TRADE', 'DAILY_LOSS_LIMIT_PERCENT', 'MAX_SAME_DIRECTION_POSITIONS',
      'SIM_SLIPPAGE_PERCENT', 'SIM_TAKER_FEE_PERCENT', 'LLM_DECISION_ENABLED', 'BACKTEST_CACHE_DIR', 'TRADING_MODE', 'KLINE_STRICT_CONTINUITY_CANDLES'].map(k => [k, example[k]])),
    {
      RISK_PERCENT_PER_TRADE: '1', MAX_MARGIN_PERCENT_PER_TRADE: '50', DAILY_LOSS_LIMIT_PERCENT: '3', MAX_SAME_DIRECTION_POSITIONS: '2',
      SIM_SLIPPAGE_PERCENT: '0.03', SIM_TAKER_FEE_PERCENT: '0.05', LLM_DECISION_ENABLED: 'false', BACKTEST_CACHE_DIR: '.cache/klines',
      TRADING_MODE: 'dry_run', KLINE_STRICT_CONTINUITY_CANDLES: '20',
    },
  );
});
