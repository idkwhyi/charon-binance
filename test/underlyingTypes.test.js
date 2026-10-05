import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUnderlyingTypes, formatUnderlyingTypes } from '../src/tools/underlyingTypes.js';

const symbols = [
  { symbol: 'BTCUSDT', underlyingType: 'COIN', underlyingSubType: ['PoW'], contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT' },
  { symbol: 'ETHUSDT', underlyingType: 'COIN', underlyingSubType: ['Layer-1'], contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT' },
  { symbol: 'BTCUSDT_261225', underlyingType: 'COIN', underlyingSubType: [], contractType: 'CURRENT_QUARTER', status: 'TRADING', quoteAsset: 'USDT' },
  { symbol: 'TSLAUSDT', underlyingType: 'EQUITY', underlyingSubType: ['TradFi'], contractType: 'TRADIFI_PERPETUAL', status: 'TRADING', quoteAsset: 'USDT' },
  { symbol: 'XAUUSDT', underlyingType: 'COMMODITY', underlyingSubType: ['TradFi'], contractType: 'TRADIFI_PERPETUAL', status: 'TRADING', quoteAsset: 'USDT' },
  { symbol: 'OLDUSDT', contractType: 'PERPETUAL', status: 'SETTLING', quoteAsset: 'USDT' },
];

test('summarizeUnderlyingTypes: counts, examples, missing type, breakdowns', () => {
  const s = summarizeUnderlyingTypes(symbols, { examples: 2 });
  assert.equal(s.total, 6);
  assert.deepEqual(s.types.map(t => [t.underlyingType, t.count]), [['COIN', 3], ['EQUITY', 1], ['COMMODITY', 1], ['(missing)', 1]]);
  const coin = s.types[0];
  assert.deepEqual(coin.examples, ['BTCUSDT', 'ETHUSDT'], 'trading USDT perpetuals first');
  assert.deepEqual(coin.contractTypes, { PERPETUAL: 2, CURRENT_QUARTER: 1 });
  assert.deepEqual(coin.subTypes, { PoW: 1, 'Layer-1': 1, '(missing)': 1 });
  assert.deepEqual(s.types[3].statuses, { SETTLING: 1 });
});

test('formatUnderlyingTypes lists every type with its count', () => {
  const out = formatUnderlyingTypes(summarizeUnderlyingTypes(symbols));
  for (const t of ['COIN  —  3 symbol(s)', 'EQUITY  —  1', 'COMMODITY  —  1', '(missing)  —  1']) assert.ok(out.includes(t), t);
});

test('npm run universe:check-types is wired to the read-only script', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(pkg.scripts['universe:check-types'], 'node universe_check_types.js');
  const src = await readFile('universe_check_types.js', 'utf8');
  assert.doesNotMatch(src, /initPgDb|pg-connection|axios\.(post|put|delete)/, 'no DB, no writes');
});
