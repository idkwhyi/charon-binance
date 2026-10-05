import { test } from 'node:test';
import assert from 'node:assert/strict';

// Set before config.js is loaded (dotenv never overrides an existing variable)
process.env.UNIVERSE_EXCLUDE_SYMBOLS = 'XAUUSDT, pinnedusdt';
process.env.TOP_GAINER_ENABLED = 'true';
const axios = (await import('axios')).default;
const { installFakePool } = await import('./helpers/fakePool.js');
const { invalidateWatchlistCache } = await import('../src/db/watchlist.js');
const { updateUniverse } = await import('../src/enrichment/topGainers.js');
const { UNIVERSE_EXCLUDE_SYMBOLS } = await import('../src/config.js');

test('live: UNIVERSE_EXCLUDE_SYMBOLS keeps a symbol out of the movers; a pinned one stays', async () => {
  assert.deepEqual(UNIVERSE_EXCLUDE_SYMBOLS, ['XAUUSDT', 'PINNEDUSDT']);
  let saved = null;
  installFakePool((text, params) => {
    if (/SELECT value FROM strategy_config/.test(text) && params[0] === 'watchlist:pinned') return [{ value: ['PINNEDUSDT'] }];
    if (/INSERT INTO strategy_config/.test(text) && params[0] === 'watchlist:symbols') saved = JSON.parse(params[1]);
    return [];
  });
  invalidateWatchlistCache();
  const coins = ['XAUUSDT', 'PINNEDUSDT', 'OKUSDT'];
  const original = axios.get;
  axios.get = async (url) => url.includes('exchangeInfo')
    ? { data: { symbols: coins.map(symbol => ({ symbol, underlyingType: 'COIN' })) } }
    : { data: coins.map(symbol => ({ symbol, quoteVolume: '90000000', priceChangePercent: '12' })) };
  const log = console.log; console.log = () => {};
  try {
    await updateUniverse(true);
  } finally { axios.get = original; console.log = log; invalidateWatchlistCache(); }
  assert.ok(saved.includes('OKUSDT'));
  assert.ok(!saved.includes('XAUUSDT'));
  assert.ok(saved.includes('PINNEDUSDT'), 'pinned symbols are explicit choices');
});
