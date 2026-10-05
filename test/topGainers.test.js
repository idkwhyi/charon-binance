import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { installFakePool } from './helpers/fakePool.js';
import { TOP_GAINER_ENABLED, WATCHLIST } from '../src/config.js';
import { invalidateWatchlistCache } from '../src/db/watchlist.js';

// Test module imports
test('topGainers module exports updateUniverse and initUniverse', async () => {
  const mod = await import('../src/enrichment/topGainers.js');
  assert(typeof mod.updateUniverse === 'function');
  assert(typeof mod.initUniverse === 'function');
});

test('telegram /topgainers links against the universe refresh (no second selection path)', async () => {
  // Fails with "does not provide an export named ..." if commands.js imports a removed export
  await import('../src/telegram/commands.js');
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/telegram/commands.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ updateUniverse \} from '\.\.\/enrichment\/topGainers\.js'/);
  assert.match(src, /async function handleTopGainers[\s\S]*?await updateUniverse\(true\)/);
});

test('updateUniverse(true): saves merged watchlist and reports added/removed without throwing', { skip: !TOP_GAINER_ENABLED }, async () => {
  const { updateUniverse } = await import('../src/enrichment/topGainers.js');
  let saved = null;
  installFakePool((text, params) => {
    if (/SELECT value FROM strategy_config/.test(text) && params[0] === 'watchlist:symbols') return [{ value: [...WATCHLIST, 'OLDUSDT'] }];
    if (/INSERT INTO strategy_config/.test(text) && params[0] === 'watchlist:symbols') saved = JSON.parse(params[1]);
    return [];
  });
  invalidateWatchlistCache();
  const original = axios.get;
  axios.get = async () => ({ data: [{ symbol: 'NEWUSDT', quoteVolume: '90000000', priceChangePercent: '-12' }] });
  const log = console.log; console.log = () => {};
  try {
    const res = await updateUniverse(true);
    assert.equal(res.updated, true);
    assert.ok(res.symbols.includes('NEWUSDT'));
    assert.deepEqual(res.added, ['NEWUSDT']);
    assert.deepEqual(res.removed, ['OLDUSDT']);
    assert.deepEqual(saved, res.symbols);
  } finally {
    axios.get = original; console.log = log; invalidateWatchlistCache();
  }
});
