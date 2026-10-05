import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STABLECOIN_PAIRS,
  universeCriteria,
  passesCriteria,
  selectTopMovers,
  mergeUniverse,
  ticker24hFromKlines15m,
} from '../src/universe/rules.js';

test('universeCriteria: default criteria', () => {
  const c = universeCriteria();
  assert.strictEqual(c.minVolume24hUsdt, 50_000_000);
  assert.strictEqual(c.minAbsChangePercent, 2);
  assert.strictEqual(c.minOpenInterestUsdt, 0);
  assert.strictEqual(c.excludeNonCrypto, true);
});

test('universeCriteria: custom values', () => {
  const c = universeCriteria({
    minVolume24hUsdt: 10_000_000,
    minAbsChangePercent: 1,
    minOpenInterestUsdt: 5_000_000,
    excludeNonCrypto: false,
  });
  assert.strictEqual(c.minVolume24hUsdt, 10_000_000);
  assert.strictEqual(c.minAbsChangePercent, 1);
  assert.strictEqual(c.minOpenInterestUsdt, 5_000_000);
  assert.strictEqual(c.excludeNonCrypto, false);
});

test('passesCriteria: good crypto ticker', () => {
  const defaultCriteria = universeCriteria();
  const ticker = {
    symbol: 'BTCUSDT',
    quoteVolume: 100_000_000,
    priceChangePercent: 5,
    openInterest: 100,
  };
  const info = { underlyingType: 'COIN' };
  assert.strictEqual(passesCriteria(ticker, defaultCriteria, info), true);
});

test('passesCriteria: reject non-USDT', () => {
  const defaultCriteria = universeCriteria();
  const ticker = {
    symbol: 'BTCBUSD',
    quoteVolume: 100_000_000,
    priceChangePercent: 5,
  };
  assert.strictEqual(passesCriteria(ticker, defaultCriteria), false);
});

test('passesCriteria: reject stablecoin', () => {
  const defaultCriteria = universeCriteria();
  const ticker = {
    symbol: 'BUSDUSDT',
    quoteVolume: 100_000_000,
    priceChangePercent: 0.1,
  };
  assert.strictEqual(passesCriteria(ticker, defaultCriteria), false);
});

test('passesCriteria: reject low volume', () => {
  const defaultCriteria = universeCriteria();
  const ticker = {
    symbol: 'LOWVOLDT',
    quoteVolume: 1_000_000,
    priceChangePercent: 5,
  };
  assert.strictEqual(passesCriteria(ticker, defaultCriteria), false);
});

test('passesCriteria: reject low price change', () => {
  const defaultCriteria = universeCriteria();
  const ticker = {
    symbol: 'STABLEDT',
    quoteVolume: 100_000_000,
    priceChangePercent: 0.5,
  };
  assert.strictEqual(passesCriteria(ticker, defaultCriteria), false);
});

test('passesCriteria: accept absolute price change', () => {
  const defaultCriteria = universeCriteria();
  const ticker = {
    symbol: 'TESTUSDT',
    quoteVolume: 100_000_000,
    priceChangePercent: -5,
  };
  assert.strictEqual(passesCriteria(ticker, defaultCriteria), true);
});

test('passesCriteria: reject non-crypto when excludeNonCrypto=true', () => {
  const defaultCriteria = universeCriteria();
  const ticker = {
    symbol: 'TSLAUSDT',
    quoteVolume: 100_000_000,
    priceChangePercent: 5,
  };
  const info = { underlyingType: 'EQUITY', underlyingSubType: 'TradFi' };
  assert.strictEqual(passesCriteria(ticker, defaultCriteria, info), false);
});

test('passesCriteria: accept non-crypto when excludeNonCrypto=false', () => {
  const criteria = universeCriteria({ excludeNonCrypto: false });
  const ticker = {
    symbol: 'TSLAUSDT',
    quoteVolume: 100_000_000,
    priceChangePercent: 5,
  };
  const info = { underlyingType: 'EQUITY', underlyingSubType: 'TradFi' };
  assert.strictEqual(passesCriteria(ticker, criteria, info), true);
});

test('passesCriteria: reject insufficient OI', () => {
  const criteria = universeCriteria({ minOpenInterestUsdt: 50_000_000 });
  const ticker = {
    symbol: 'LOWOIUSDT',
    quoteVolume: 100_000_000,
    priceChangePercent: 5,
    openInterest: 10_000_000,
  };
  assert.strictEqual(passesCriteria(ticker, criteria), false);
});

test('passesCriteria: accept sufficient OI', () => {
  const criteria = universeCriteria({ minOpenInterestUsdt: 50_000_000 });
  const ticker = {
    symbol: 'GOODUSDT',
    quoteVolume: 100_000_000,
    priceChangePercent: 5,
    openInterest: 60_000_000,
  };
  const info = { underlyingType: 'COIN' };
  assert.strictEqual(passesCriteria(ticker, criteria, info), true);
});

test('selectTopMovers: sort by absolute price change', () => {
  const tickers = [
    { symbol: 'AAUSDT', quoteVolume: 100_000_000, priceChangePercent: 3 },
    { symbol: 'BBUSDT', quoteVolume: 100_000_000, priceChangePercent: -7 },
    { symbol: 'CCUSDT', quoteVolume: 100_000_000, priceChangePercent: 5 },
  ];
  const criteria = universeCriteria();
  const result = selectTopMovers(tickers, criteria);
  assert.deepStrictEqual(result, ['BBUSDT', 'CCUSDT', 'AAUSDT']);
});

test('selectTopMovers: filter non-matching', () => {
  const tickers = [
    { symbol: 'BTCUSDT', quoteVolume: 100_000_000, priceChangePercent: 5 },
    { symbol: 'LOWVOLDT', quoteVolume: 1_000_000, priceChangePercent: 10 },
    { symbol: 'ETHUSDT', quoteVolume: 100_000_000, priceChangePercent: 3 },
  ];
  const criteria = universeCriteria();
  const result = selectTopMovers(tickers, criteria);
  assert.deepStrictEqual(result, ['BTCUSDT', 'ETHUSDT']);
});

test('selectTopMovers: respect exchangeInfoMap', () => {
  const tickers = [
    { symbol: 'BTCUSDT', quoteVolume: 100_000_000, priceChangePercent: 5 },
    { symbol: 'TSLAUSDT', quoteVolume: 100_000_000, priceChangePercent: 7 },
  ];
  const criteria = universeCriteria();
  const exchangeInfoMap = new Map([
    ['BTCUSDT', { underlyingType: 'COIN' }],
    ['TSLAUSDT', { underlyingType: 'EQUITY' }],
  ]);
  const result = selectTopMovers(tickers, criteria, exchangeInfoMap);
  assert.deepStrictEqual(result, ['BTCUSDT']);
});

test('selectTopMovers: can be sliced to limit results', () => {
  const tickers = [
    { symbol: 'A1USDT', quoteVolume: 100_000_000, priceChangePercent: 1 },
    { symbol: 'B1USDT', quoteVolume: 100_000_000, priceChangePercent: 2 },
    { symbol: 'C1USDT', quoteVolume: 100_000_000, priceChangePercent: 3 },
    { symbol: 'D1USDT', quoteVolume: 100_000_000, priceChangePercent: 4 },
  ];
  const criteria = universeCriteria();
  const result = selectTopMovers(tickers, criteria).slice(0, 2);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0], 'D1USDT');
  assert.strictEqual(result[1], 'C1USDT');
});

test('mergeUniverse: always include pinned', () => {
  const candidates = ['NEW1USDT', 'NEW2USDT'];
  const pinned = ['BTCUSDT', 'ETHUSDT'];
  const envDefaults = [];
  const result = mergeUniverse(candidates, pinned, envDefaults);
  assert(result.includes('BTCUSDT'));
  assert(result.includes('ETHUSDT'));
});

test('mergeUniverse: always include env defaults', () => {
  const candidates = ['NEW1USDT'];
  const pinned = [];
  const envDefaults = ['BTCUSDT', 'BNBUSDT'];
  const result = mergeUniverse(candidates, pinned, envDefaults);
  assert(result.includes('BTCUSDT'));
  assert(result.includes('BNBUSDT'));
});

test('mergeUniverse: fill slots with candidates', () => {
  const candidates = ['NEW1USDT', 'NEW2USDT', 'NEW3USDT'];
  const pinned = ['PIN1USDT'];
  const envDefaults = ['ENV1USDT'];
  const maxTotal = 5;
  const result = mergeUniverse(candidates, pinned, envDefaults, maxTotal);
  assert(result.includes('PIN1USDT'));
  assert(result.includes('ENV1USDT'));
  assert(result.includes('NEW1USDT'));
  assert(result.includes('NEW2USDT'));
  assert(result.includes('NEW3USDT'));
  assert.strictEqual(result.length, 5);
});

test('mergeUniverse: not exceed maxTotal', () => {
  const candidates = Array.from({ length: 100 }, (_, i) => `NEW${i}USDT`);
  const pinned = ['PIN1USDT'];
  const envDefaults = ['ENV1USDT', 'ENV2USDT'];
  const maxTotal = 50;
  const result = mergeUniverse(candidates, pinned, envDefaults, maxTotal);
  assert(result.length <= maxTotal);
});

test('mergeUniverse: no duplicates', () => {
  const candidates = ['DUP1USDT', 'DUP2USDT'];
  const pinned = ['DUP1USDT'];
  const envDefaults = ['DUP2USDT'];
  const result = mergeUniverse(candidates, pinned, envDefaults);
  const unique = new Set(result);
  assert.strictEqual(result.length, unique.size);
});

test('mergeUniverse: prefer pinned over candidates when space limited', () => {
  const candidates = ['NEW1USDT', 'NEW2USDT', 'NEW3USDT'];
  const pinned = ['PIN1USDT'];
  const envDefaults = [];
  const maxTotal = 2;
  const result = mergeUniverse(candidates, pinned, envDefaults, maxTotal);
  assert(result.includes('PIN1USDT'));
  assert.strictEqual(result.length, 2);
});

test('ticker24hFromKlines15m: calculate quoteVolume (96 candles = 24h)', () => {
  const klines = Array.from({ length: 96 }, (_, i) => ({
    openTime: i * 15 * 60 * 1000,
    open: 100,
    high: 110,
    low: 90,
    close: 100 + (i % 10), // some variation
    volume: 10,
    quoteVolume: 1000 + i * 10,
    closeTime: (i + 1) * 15 * 60 * 1000 - 1,
  }));
  const result = ticker24hFromKlines15m(klines);
  const expected = klines.reduce((s, k) => s + k.quoteVolume, 0);
  assert.strictEqual(result.quoteVolume, expected);
});

test('ticker24hFromKlines15m: calculate priceChangePercent (first open vs last close)', () => {
  const klines = Array.from({ length: 96 }, (_, i) => ({
    openTime: i * 15 * 60 * 1000,
    open: i === 0 ? 100 : 100 + (i-1),
    high: 110,
    low: 90,
    close: 100 + i,
    volume: 10,
    quoteVolume: 1000,
    closeTime: (i + 1) * 15 * 60 * 1000 - 1,
  }));
  const result = ticker24hFromKlines15m(klines);
  // first.open = 100, last.close = 100 + 95 = 195
  // change = (195-100)/100*100 = 95%
  assert.strictEqual(result.priceChangePercent, 95);
});

test('ticker24hFromKlines15m: empty klines', () => {
  const result = ticker24hFromKlines15m([]);
  assert.strictEqual(result.quoteVolume, 0);
  assert.strictEqual(result.priceChangePercent, 0);
});

test('ticker24hFromKlines15m: less than 96 candles (uses available)', () => {
  const klines = Array.from({ length: 50 }, (_, i) => ({
    openTime: i * 15 * 60 * 1000,
    open: 100,
    high: 110,
    low: 90,
    close: 100 + i,
    volume: 10,
    quoteVolume: 1000,
    closeTime: (i + 1) * 15 * 60 * 1000 - 1,
  }));
  const result = ticker24hFromKlines15m(klines);
  // 50 * 1000 = 50000
  assert.strictEqual(result.quoteVolume, 50000);
  // first.open = 100, last.close = 100 + 49 = 149
  // change = (149-100)/100*100 = 49%
  assert.strictEqual(result.priceChangePercent, 49);
});

test('ticker24hFromKlines15m: zero open price', () => {
  const klines = Array.from({ length: 96 }, (_, i) => ({
    openTime: i * 15 * 60 * 1000,
    open: i === 0 ? 0 : 100,
    high: 110,
    low: 90,
    close: 100,
    volume: 10,
    quoteVolume: 1000,
    closeTime: (i + 1) * 15 * 60 * 1000 - 1,
  }));
  const result = ticker24hFromKlines15m(klines);
  assert.strictEqual(result.priceChangePercent, 0);
});

test('STABLECOIN_PAIRS: has all stablecoins', () => {
  assert(STABLECOIN_PAIRS.has('BUSDUSDT'));
  assert(STABLECOIN_PAIRS.has('USDCUSDT'));
  assert(STABLECOIN_PAIRS.has('TUSDUSDT'));
  assert(STABLECOIN_PAIRS.has('USDTUSDT'));
  assert(STABLECOIN_PAIRS.has('DAIUSDT'));
  assert(STABLECOIN_PAIRS.has('FDUSDUSDT'));
});

test('non-crypto filter: exclude TSLAUSDT (EQUITY/TradFi)', () => {
  const criteria = universeCriteria({ excludeNonCrypto: true });
  const ticker = {
    symbol: 'TSLAUSDT',
    quoteVolume: 100_000_000,
    priceChangePercent: 5,
  };
  const info = { underlyingType: 'EQUITY', underlyingSubType: 'TradFi' };
  assert.strictEqual(passesCriteria(ticker, criteria, info), false);
});

test('non-crypto filter: exclude MSTRUSDT (EQUITY/TradFi)', () => {
  const criteria = universeCriteria({ excludeNonCrypto: true });
  const ticker = {
    symbol: 'MSTRUSDT',
    quoteVolume: 100_000_000,
    priceChangePercent: 5,
  };
  const info = { underlyingType: 'EQUITY', underlyingSubType: 'TradFi' };
  assert.strictEqual(passesCriteria(ticker, criteria, info), false);
});

test('non-crypto filter: exclude SOXSUSDT (EQUITY/TradFi)', () => {
  const criteria = universeCriteria({ excludeNonCrypto: true });
  const ticker = {
    symbol: 'SOXSUSDT',
    quoteVolume: 100_000_000,
    priceChangePercent: 5,
  };
  const info = { underlyingType: 'EQUITY', underlyingSubType: 'TradFi' };
  assert.strictEqual(passesCriteria(ticker, criteria, info), false);
});

test('non-crypto filter: include crypto despite non-COIN underlyingType if excludeNonCrypto=false', () => {
  const criteria = universeCriteria({ excludeNonCrypto: false });
  const ticker = {
    symbol: 'MSTRUSDT',
    quoteVolume: 100_000_000,
    priceChangePercent: 5,
  };
  const info = { underlyingType: 'EQUITY', underlyingSubType: 'TradFi' };
  assert.strictEqual(passesCriteria(ticker, criteria, info), true);
});
