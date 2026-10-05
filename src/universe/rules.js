/**
 * Shared Universe Selection Rules
 *
 * Centralized logic for:
 * - Selecting top gainer candidates from tickers
 * - Merging with pinned/env symbols
 * - Filtering non-crypto assets
 * - Applying OI filter (live & backtest)
 *
 * Used by both live bot (enrichment/topGainers) and backtest (runner).
 */

/**
 * Stablecoin pairs: never included in dynamic universe.
 */
export const STABLECOIN_PAIRS = new Set([
  'BUSDUSDT', 'USDCUSDT', 'TUSDUSDT', 'USDTUSDT', 'DAIUSDT', 'FDUSDUSDT'
]);

/**
 * Universe selection criteria.
 * @param {object} opts
 *   - minVolume24hUsdt: min 24h quote volume (default: 50M)
 *   - minAbsChangePercent: min |24h price change %| (default: 2)
 *   - minOpenInterestUsdt: min OI (default: 0, disabled)
 *   - excludeNonCrypto: exclude underlyingType='EQUITY' (default: true)
 * @returns {object} criteria object
 */
export function universeCriteria({
  minVolume24hUsdt = 50_000_000,
  minAbsChangePercent = 2,
  minOpenInterestUsdt = 0,
  excludeNonCrypto = true,
} = {}) {
  return {
    minVolume24hUsdt,
    minAbsChangePercent,
    minOpenInterestUsdt,
    excludeNonCrypto,
  };
}

/**
 * Check if a ticker passes the universe selection criteria.
 * @param {object} ticker - Binance 24h ticker
 *   - symbol: string
 *   - quoteVolume: number (24h)
 *   - priceChangePercent: number
 *   - openInterest: number (optional, for OI filter)
 * @param {object} criteria - from universeCriteria()
 * @param {object} exchangeInfo - optional, from fetchExchangeInfo(symbol)
 *   - underlyingType: 'COIN' | 'EQUITY' | null
 * @returns {boolean}
 */
export function passesCriteria(ticker, criteria, exchangeInfo = null) {
  const sym = String(ticker.symbol || '');
  const vol = Number(ticker.quoteVolume || 0);
  const pct = Math.abs(Number(ticker.priceChangePercent || 0));
  const oi = Number(ticker.openInterest || 0);

  return (
    sym.endsWith('USDT') &&
    !STABLECOIN_PAIRS.has(sym) &&
    vol >= criteria.minVolume24hUsdt &&
    pct >= criteria.minAbsChangePercent &&
    (criteria.minOpenInterestUsdt <= 0 || oi >= criteria.minOpenInterestUsdt) &&
    (!criteria.excludeNonCrypto || !exchangeInfo || exchangeInfo.underlyingType === 'COIN')
  );
}

/**
 * Select top gainer candidates from tickers.
 * @param {object[]} tickers - Binance 24h tickers
 * @param {object} criteria - from universeCriteria()
 * @param {Map<string, object>} exchangeInfoMap - optional, symbol => exchangeInfo
 * @returns {string[]} sorted symbol list (top movers by |priceChangePercent|)
 */
export function selectTopMovers(tickers, criteria, exchangeInfoMap = null) {
  const filtered = tickers
    .filter(t => {
      const info = exchangeInfoMap ? exchangeInfoMap.get(String(t.symbol)) : null;
      return passesCriteria(t, criteria, info);
    })
    .sort((a, b) =>
      Math.abs(Number(b.priceChangePercent || 0)) -
      Math.abs(Number(a.priceChangePercent || 0))
    );

  return filtered.map(t => t.symbol);
}

/**
 * Merge universe symbols: always keep pinned + env defaults, fill remaining
 * slots with auto-discovered candidates.
 * @param {string[]} candidates - auto-discovered symbols (e.g., top gainers)
 * @param {string[]} pinned - user-pinned symbols (never removed)
 * @param {string[]} envDefaults - env WATCHLIST defaults (always in base)
 * @param {number} maxTotal - max total watchlist size (default: 50)
 * @returns {string[]} merged unique symbols
 */
export function mergeUniverse(candidates, pinned = [], envDefaults = [], maxTotal = 50) {
  // Base: always keep pinned + env defaults
  const base = [...new Set([...pinned, ...envDefaults])];

  // Fill remaining slots with candidates not already in base
  const remaining = maxTotal - base.length;
  const extras = candidates
    .filter(s => !base.includes(s))
    .slice(0, Math.max(0, remaining));

  return [...new Set([...base, ...extras])];
}

/**
 * Calculate 24h stats from 15m klines (used by backtest when ticker data unavailable).
 * 96 15m candles = 24 hours. Returns approximation of 24h ticker snapshot.
 * @param {object[]} klines15m - last 96+ 15m candles, sorted by openTime
 * @returns {object} { quoteVolume, priceChangePercent }
 */
export function ticker24hFromKlines15m(klines15m) {
  const window = klines15m.slice(-96); // trailing 24 hours (96 * 15min)
  if (window.length === 0) {
    return { quoteVolume: 0, priceChangePercent: 0 };
  }
  const first = window[0];
  const last = window[window.length - 1];
  const quoteVolume = window.reduce((s, k) => s + k.quoteVolume, 0);
  const priceChangePercent = first.open > 0
    ? ((last.close - first.open) / first.open) * 100
    : 0;
  return { quoteVolume, priceChangePercent };
}
