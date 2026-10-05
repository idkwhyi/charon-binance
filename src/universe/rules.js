/**
 * Shared Universe Selection Rules
 *
 * Centralized logic for:
 * - Selecting top gainer candidates from tickers
 * - Merging with pinned/env symbols
 * - Allowlisting crypto (underlyingType COIN only)
 * - Applying OI filter (live & backtest)
 *
 * Used by both live bot (enrichment/topGainers) and backtest (runner).
 */

/**
 * The universe rules, shared by the live screener and the backtest:
 * pinned + env WATCHLIST are always in; on top of them, the top `topN`
 * symbols by |24h price change| (up or down) among those with 24h quote
 * volume >= minVolume24hUsdt, |change| >= minAbsChangePercent, not a
 * stablecoin, underlyingType COIN. A symbol leaves as soon as it drops out
 * of the top `topN` (unless pinned/env).
 */
export const UNIVERSE_RULES = Object.freeze({
  topN: 50,
  minVolume24hUsdt: 50_000_000,
  minAbsChangePercent: 2,
  coinOnly: true,
});

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
 *   - coinOnly: allowlist — only underlyingType 'COIN' passes; EQUITY,
 *     commodity, index or unknown/missing exchange info are rejected (default: true)
 * @returns {object} criteria object
 */
export function universeCriteria({
  minVolume24hUsdt = UNIVERSE_RULES.minVolume24hUsdt,
  minAbsChangePercent = UNIVERSE_RULES.minAbsChangePercent,
  minOpenInterestUsdt = 0,
  coinOnly = UNIVERSE_RULES.coinOnly,
} = {}) {
  return {
    minVolume24hUsdt,
    minAbsChangePercent,
    minOpenInterestUsdt,
    coinOnly,
  };
}

/** Allowlist: true only for exchange info with underlyingType 'COIN'. */
export function isCoinUnderlying(exchangeInfo) {
  return exchangeInfo?.underlyingType === 'COIN';
}

/**
 * symbol => exchange info, from the exchangeInfo `symbols` array
 * (GET /fapi/v1/exchangeInfo). Pass the result to selectTopMovers.
 */
export function exchangeInfoMap(symbols = []) {
  return new Map(symbols.map(s => [String(s.symbol), s]));
}

/**
 * Check if a ticker passes the universe selection criteria.
 * @param {object} ticker - Binance 24h ticker
 *   - symbol: string
 *   - quoteVolume: number (24h)
 *   - priceChangePercent: number
 *   - openInterest: number (optional, for OI filter)
 * @param {object} criteria - from universeCriteria()
 * @param {object|null} exchangeInfo - the symbol's exchangeInfo entry
 *   - underlyingType: 'COIN' | 'EQUITY' | ... — with coinOnly, anything but
 *     'COIN' (including a missing entry) is rejected
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
    (!criteria.coinOnly || isCoinUnderlying(exchangeInfo))
  );
}

/**
 * Select top gainer candidates from tickers.
 * @param {object[]} tickers - Binance 24h tickers
 * @param {object} criteria - from universeCriteria()
 * @param {Map<string, object>|null} exchangeInfoMap - symbol => exchangeInfo (see
 *   exchangeInfoMap()); required when criteria.coinOnly, else nothing passes
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
 * Universe = pinned + env defaults (always kept) + the given movers. No
 * overall cap: movers are already limited to the top N, so a mover ranked
 * N-5 is never squeezed out by pinned/env symbols.
 * @param {string[]} movers - top movers (e.g. selectTopMovers(...).slice(0, topN))
 * @param {string[]} pinned - user-pinned symbols (never removed)
 * @param {string[]} envDefaults - env WATCHLIST defaults (never removed)
 * @returns {string[]} unique symbols: pinned, env, then movers in rank order
 */
export function mergeUniverse(movers, pinned = [], envDefaults = []) {
  return [...new Set([...pinned, ...envDefaults, ...movers])];
}

/**
 * Apply UNIVERSE_RULES to one 24h-ticker snapshot. The single entry point
 * for both the live screener and the backtest's point-in-time universe.
 * @param {object[]} tickers - { symbol, quoteVolume, priceChangePercent }
 * @param {object} ctx
 * @param {Map<string, object>|null} ctx.exchangeInfo - see exchangeInfoMap()
 * @param {string[]} [ctx.pinned]
 * @param {string[]} [ctx.envDefaults]
 * @param {object} [ctx.rules] - defaults to UNIVERSE_RULES
 * @returns {{ movers: string[], symbols: string[] }}
 */
export function selectUniverse(tickers, { exchangeInfo = null, pinned = [], envDefaults = [], rules = UNIVERSE_RULES } = {}) {
  const movers = selectTopMovers(tickers, universeCriteria(rules), exchangeInfo).slice(0, rules.topN);
  return { movers, symbols: mergeUniverse(movers, pinned, envDefaults) };
}

/** Symbols that entered / left between two universe snapshots. */
export function diffUniverse(before = [], after = []) {
  const b = new Set(before), a = new Set(after);
  return { added: after.filter(s => !b.has(s)), removed: before.filter(s => !a.has(s)) };
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
