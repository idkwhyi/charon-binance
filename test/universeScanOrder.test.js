import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { scanSignals, setCycleHandler, _klineCacheForTest } from '../src/signals/scanner.js';
import { installFakePool } from './helpers/fakePool.js';
import { TOP_GAINER_ENABLED } from '../src/config.js';
import { invalidateWatchlistCache } from '../src/db/watchlist.js';

// Live order must match the backtest: at a 15m close the universe is refreshed
// first and that same scan runs on it — also on cycles with no signals.
test('scanSignals refreshes the universe before scanning, even when no signal triggers', { skip: !TOP_GAINER_ENABLED }, async () => {
  let stored = null;
  installFakePool((text, params) => {
    if (/SELECT value FROM strategy_config/.test(text) && params[0] === 'watchlist:symbols') return stored ? [{ value: stored }] : [];
    if (/INSERT INTO strategy_config/.test(text) && params[0] === 'watchlist:symbols') stored = JSON.parse(params[1]);
    return [];
  });
  invalidateWatchlistCache();
  _klineCacheForTest().clear();
  const klineSymbols = [];
  const original = axios.get;
  axios.get = async (url, { params = {} } = {}) => {
    if (url.includes('exchangeInfo')) return { data: { symbols: [{ symbol: 'MOVERUSDT', underlyingType: 'COIN' }] } };
    if (url.endsWith('/ticker/24hr')) return { data: [{ symbol: 'MOVERUSDT', quoteVolume: '80000000', priceChangePercent: '9' }] };
    if (url.includes('/klines')) { klineSymbols.push(params.symbol); return { data: [] }; }
    return { data: {} };
  };
  let cycles = 0;
  setCycleHandler(async () => { cycles++; });
  const log = console.log; console.log = () => {};
  try {
    await scanSignals();
  } finally {
    axios.get = original; console.log = log; invalidateWatchlistCache();
  }
  assert.ok(stored?.includes('MOVERUSDT'), 'universe refreshed without any signal');
  assert.ok(klineSymbols.includes('MOVERUSDT'), 'the same scan already covers the new symbol');
  assert.equal(cycles, 0);
});

test('the orchestrator no longer refreshes the universe (it only runs on cycles with signals)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/pipeline/orchestrator.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /updateUniverse/);
});
