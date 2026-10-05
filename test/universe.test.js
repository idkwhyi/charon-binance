import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STABLECOIN_PAIRS,
  universeCriteria,
  passesCriteria,
  selectTopMovers,
  mergeUniverse,
  ticker24hFromKlines15m,
  exchangeInfoMap,
  selectUniverse,
  diffUniverse,
  UNIVERSE_RULES,
  universeRules,
} from '../src/universe/rules.js';

const COIN = { underlyingType: 'COIN' };
const coinMap = (tickers) => exchangeInfoMap(tickers.map(t => ({ symbol: t.symbol, underlyingType: 'COIN' })));

test('universeCriteria: default criteria', () => {
  const c = universeCriteria();
  assert.strictEqual(c.minVolume24hUsdt, 50_000_000);
  assert.strictEqual(c.minAbsChangePercent, 2);
  assert.strictEqual(c.minOpenInterestUsdt, 0);
  assert.strictEqual(c.coinOnly, true);
});

test('universeCriteria: custom values', () => {
  const c = universeCriteria({
    minVolume24hUsdt: 10_000_000,
    minAbsChangePercent: 1,
    minOpenInterestUsdt: 5_000_000,
    coinOnly: false,
  });
  assert.strictEqual(c.minVolume24hUsdt, 10_000_000);
  assert.strictEqual(c.minAbsChangePercent, 1);
  assert.strictEqual(c.minOpenInterestUsdt, 5_000_000);
  assert.strictEqual(c.coinOnly, false);
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
  assert.strictEqual(passesCriteria(ticker, defaultCriteria, COIN), true);
});

test('passesCriteria: reject non-crypto when coinOnly=true', () => {
  const defaultCriteria = universeCriteria();
  const ticker = {
    symbol: 'TSLAUSDT',
    quoteVolume: 100_000_000,
    priceChangePercent: 5,
  };
  const info = { underlyingType: 'EQUITY', underlyingSubType: 'TradFi' };
  assert.strictEqual(passesCriteria(ticker, defaultCriteria, info), false);
});

test('passesCriteria: accept non-crypto when coinOnly=false', () => {
  const criteria = universeCriteria({ coinOnly: false });
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
  const result = selectTopMovers(tickers, criteria, coinMap(tickers));
  assert.deepStrictEqual(result, ['BBUSDT', 'CCUSDT', 'AAUSDT']);
});

test('selectTopMovers: filter non-matching', () => {
  const tickers = [
    { symbol: 'BTCUSDT', quoteVolume: 100_000_000, priceChangePercent: 5 },
    { symbol: 'LOWVOLDT', quoteVolume: 1_000_000, priceChangePercent: 10 },
    { symbol: 'ETHUSDT', quoteVolume: 100_000_000, priceChangePercent: 3 },
  ];
  const criteria = universeCriteria();
  const result = selectTopMovers(tickers, criteria, coinMap(tickers));
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
  const result = selectTopMovers(tickers, criteria, coinMap(tickers)).slice(0, 2);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0], 'D1USDT');
  assert.strictEqual(result[1], 'C1USDT');
});

test('mergeUniverse: pinned + env always kept, movers added, no duplicates', () => {
  const result = mergeUniverse(['NEW1USDT', 'BTCUSDT', 'NEW2USDT'], ['PIN1USDT', 'BTCUSDT'], ['BTCUSDT', 'ETHUSDT']);
  assert.deepStrictEqual(result, ['PIN1USDT', 'BTCUSDT', 'ETHUSDT', 'NEW1USDT', 'NEW2USDT']);
});

test('mergeUniverse: no overall cap — pinned/env never squeeze out a top mover', () => {
  const movers = Array.from({ length: 50 }, (_, i) => `M${i}USDT`);
  const env = Array.from({ length: 10 }, (_, i) => `E${i}USDT`);
  const result = mergeUniverse(movers, [], env);
  assert.strictEqual(result.length, 60);
  assert.ok(result.includes('M49USDT'));
});

const tk = (symbol, pct, vol = 100_000_000) => ({ symbol, quoteVolume: vol, priceChangePercent: pct });

test('UNIVERSE_RULES: top 50, 24h volume >= 50M, |change| >= 2%, COIN only', () => {
  assert.deepStrictEqual({ ...UNIVERSE_RULES }, { topN: 50, minVolume24hUsdt: 50_000_000, minAbsChangePercent: 2, coinOnly: true, excludeSymbols: [] });
  const c = universeCriteria();
  assert.strictEqual(c.minVolume24hUsdt, UNIVERSE_RULES.minVolume24hUsdt);
  assert.strictEqual(c.minAbsChangePercent, UNIVERSE_RULES.minAbsChangePercent);
});

test('selectUniverse: ranks by |24h change| both ways, keeps top N, applies every filter', () => {
  const tickers = [
    ...Array.from({ length: 55 }, (_, i) => tk(`C${String(i).padStart(2, '0')}USDT`, (i % 2 ? -1 : 1) * (3 + i))),
    tk('LOWVOLUSDT', 90, 49_999_999),
    tk('FLATUSDT', 1.99),
    tk('USDCUSDT', 99),
    tk('TSLAUSDT', 80),
  ];
  const info = exchangeInfoMap([
    ...tickers.map(t => ({ symbol: t.symbol, underlyingType: 'COIN' })).filter(x => x.symbol !== 'TSLAUSDT'),
    { symbol: 'TSLAUSDT', underlyingType: 'EQUITY' },
  ]);
  const { movers, symbols } = selectUniverse(tickers, { exchangeInfo: info, pinned: ['PINUSDT'], envDefaults: ['C00USDT', 'ENVUSDT'] });
  assert.strictEqual(movers.length, 50);
  assert.strictEqual(movers[0], 'C54USDT');
  assert.strictEqual(movers[1], 'C53USDT', 'negative change ranks by absolute value');
  assert.ok(!movers.includes('C04USDT') && !movers.includes('C00USDT'), 'ranks 51+ are out');
  for (const s of ['LOWVOLUSDT', 'FLATUSDT', 'USDCUSDT', 'TSLAUSDT']) assert.ok(!movers.includes(s), s);
  assert.deepStrictEqual(symbols.slice(0, 3), ['PINUSDT', 'C00USDT', 'ENVUSDT'], 'pinned + env kept even outside top N');
  assert.strictEqual(symbols.length, 53);
});

test('selectUniverse: a symbol leaves when it drops out of the top N; pinned/env never leave', () => {
  const info = exchangeInfoMap(['AUSDT', 'BUSDT', 'CUSDT', 'ENVUSDT'].map(symbol => ({ symbol, underlyingType: 'COIN' })));
  const rules = { ...UNIVERSE_RULES, topN: 2 };
  const ctx = { exchangeInfo: info, envDefaults: ['ENVUSDT'], rules };
  const t0 = selectUniverse([tk('AUSDT', 9), tk('BUSDT', 8), tk('CUSDT', 3), tk('ENVUSDT', 0)], ctx).symbols;
  const t1 = selectUniverse([tk('AUSDT', 9), tk('BUSDT', 2.5), tk('CUSDT', -7), tk('ENVUSDT', 0)], ctx).symbols;
  assert.deepStrictEqual(t0, ['ENVUSDT', 'AUSDT', 'BUSDT']);
  assert.deepStrictEqual(t1, ['ENVUSDT', 'AUSDT', 'CUSDT']);
  assert.deepStrictEqual(diffUniverse(t0, t1), { added: ['CUSDT'], removed: ['BUSDT'] });
  assert.deepStrictEqual(selectUniverse([tk('AUSDT', 1)], ctx).symbols, ['ENVUSDT'], 'no movers: only pinned + env');
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
  const criteria = universeCriteria({ coinOnly: true });
  const ticker = {
    symbol: 'TSLAUSDT',
    quoteVolume: 100_000_000,
    priceChangePercent: 5,
  };
  const info = { underlyingType: 'EQUITY', underlyingSubType: 'TradFi' };
  assert.strictEqual(passesCriteria(ticker, criteria, info), false);
});

test('non-crypto filter: exclude MSTRUSDT (EQUITY/TradFi)', () => {
  const criteria = universeCriteria({ coinOnly: true });
  const ticker = {
    symbol: 'MSTRUSDT',
    quoteVolume: 100_000_000,
    priceChangePercent: 5,
  };
  const info = { underlyingType: 'EQUITY', underlyingSubType: 'TradFi' };
  assert.strictEqual(passesCriteria(ticker, criteria, info), false);
});

test('non-crypto filter: exclude SOXSUSDT (EQUITY/TradFi)', () => {
  const criteria = universeCriteria({ coinOnly: true });
  const ticker = {
    symbol: 'SOXSUSDT',
    quoteVolume: 100_000_000,
    priceChangePercent: 5,
  };
  const info = { underlyingType: 'EQUITY', underlyingSubType: 'TradFi' };
  assert.strictEqual(passesCriteria(ticker, criteria, info), false);
});

test('non-crypto filter: include crypto despite non-COIN underlyingType if coinOnly=false', () => {
  const criteria = universeCriteria({ coinOnly: false });
  const ticker = {
    symbol: 'MSTRUSDT',
    quoteVolume: 100_000_000,
    priceChangePercent: 5,
  };
  const info = { underlyingType: 'EQUITY', underlyingSubType: 'TradFi' };
  assert.strictEqual(passesCriteria(ticker, criteria, info), true);
});

test('coin allowlist: commodity, index and unknown underlying types are rejected', () => {
  const criteria = universeCriteria();
  const t = sym => ({ symbol: sym, quoteVolume: 100_000_000, priceChangePercent: 5 });
  assert.strictEqual(passesCriteria(t('XAUUSDT'), criteria, { underlyingType: 'COMMODITY' }), false);
  assert.strictEqual(passesCriteria(t('IDXUSDT'), criteria, { underlyingType: 'INDEX' }), false);
  assert.strictEqual(passesCriteria(t('NEWUSDT'), criteria, { underlyingType: 'SOMETHING_NEW' }), false);
  assert.strictEqual(passesCriteria(t('NOINFOUSDT'), criteria, {}), false);
  assert.strictEqual(passesCriteria(t('NOINFOUSDT'), criteria, null), false, 'missing exchange info is not COIN');
  assert.strictEqual(passesCriteria(t('BTCUSDT'), criteria, COIN), true);
});

test('coin allowlist: selectTopMovers without an exchange info map selects nothing', () => {
  const tickers = [{ symbol: 'BTCUSDT', quoteVolume: 100_000_000, priceChangePercent: 5 }];
  assert.deepStrictEqual(selectTopMovers(tickers, universeCriteria()), []);
  assert.deepStrictEqual(selectTopMovers(tickers, universeCriteria(), coinMap(tickers)), ['BTCUSDT']);
});

test('UNIVERSE_EXCLUDE_SYMBOLS: excluded symbols never enter as movers; pinned/env stay', () => {
  const rules = universeRules({ excludeSymbols: [' xauusdt', 'AUSDT'] });
  assert.deepStrictEqual([...rules.excludeSymbols], ['XAUUSDT', 'AUSDT']);
  const tickers = [tk('XAUUSDT', 20), tk('AUSDT', 9), tk('BUSDT', 5)];
  const info = exchangeInfoMap(tickers.map(t => ({ symbol: t.symbol, underlyingType: 'COIN' })));
  const { movers, symbols } = selectUniverse(tickers, { exchangeInfo: info, envDefaults: ['AUSDT'], rules });
  assert.deepStrictEqual(movers, ['BUSDT']);
  assert.deepStrictEqual(symbols, ['AUSDT', 'BUSDT'], 'AUSDT kept as an env symbol');
  assert.deepStrictEqual(selectUniverse(tickers, { exchangeInfo: info }).movers, ['XAUUSDT', 'AUSDT', 'BUSDT'], 'default: no exclusions');
});
