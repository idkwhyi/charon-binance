import axios from 'axios';
import { BINANCE_FUTURES_BASE_URL, BINANCE_API_KEY, BINANCE_API_SECRET, JSON_HEADERS } from '../config.js';
import { buildSignedParams, sleep } from '../utils.js';

const BASE = BINANCE_FUTURES_BASE_URL;

function headers() {
  return { ...JSON_HEADERS, 'X-MBX-APIKEY': BINANCE_API_KEY };
}

/**
 * Public: fetch 24h ticker for a symbol or all symbols.
 */
export async function fetchTicker24h(symbol = null) {
  const url = symbol
    ? `${BASE}/fapi/v1/ticker/24hr?symbol=${symbol}`
    : `${BASE}/fapi/v1/ticker/24hr`;
  const res = await axios.get(url, { timeout: 8_000, headers: JSON_HEADERS });
  return res.data;
}

/**
 * Public: fetch klines (candlesticks).
 * @param {string} symbol
 * @param {string} interval - '1m','5m','15m','1h','4h','1d'
 * @param {number} limit - max 1500
 */
export async function fetchKlines(symbol, interval = '15m', limit = 100) {
  const res = await axios.get(`${BASE}/fapi/v1/klines`, {
    timeout: 8_000,
    headers: JSON_HEADERS,
    params: { symbol, interval, limit },
  });
  // Returns: [openTime, open, high, low, close, volume, ...]
  return res.data.map(k => ({
    openTime: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: k[6],
    quoteVolume: Number(k[7]),
  }));
}

/**
 * Public: fetch a full historical kline range, paginating past Binance's
 * 1500-candle-per-request limit. Used by the backtest engine to pull months
 * of data. `endTime` is inclusive; candles beyond it are trimmed off.
 */
export async function fetchKlinesRange(symbol, interval, startTime, endTime, { pauseMs = 250 } = {}) {
  const maxBatch = 1500;
  const all = [];
  let cursor = startTime;

  while (cursor <= endTime) {
    const res = await axios.get(`${BASE}/fapi/v1/klines`, {
      timeout: 10_000,
      headers: JSON_HEADERS,
      params: { symbol, interval, startTime: cursor, endTime, limit: maxBatch },
    });

    const batch = res.data.map(k => ({
      openTime: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: k[6],
      quoteVolume: Number(k[7]),
    }));

    if (batch.length === 0) break;
    all.push(...batch);

    if (batch.length < maxBatch) break; // last page reached
    cursor = batch[batch.length - 1].closeTime + 1;
    await sleep(pauseMs); // stay well under Binance's request-weight limit
  }

  return all.filter(k => k.openTime <= endTime);
}

/**
 * Public: fetch premium index (mark price + funding rate).
 */
export async function fetchPremiumIndex(symbol) {
  const res = await axios.get(`${BASE}/fapi/v1/premiumIndex`, {
    timeout: 8_000,
    headers: JSON_HEADERS,
    params: { symbol },
  });
  return res.data;
}

/**
 * Public: fetch open interest.
 */
export async function fetchOpenInterest(symbol) {
  const res = await axios.get(`${BASE}/fapi/v1/openInterest`, {
    timeout: 8_000,
    headers: JSON_HEADERS,
    params: { symbol },
  });
  return res.data;
}

/**
 * Public: fetch exchange info for a symbol (precision, tick size).
 */
export async function fetchExchangeInfo(symbol) {
  const res = await axios.get(`${BASE}/fapi/v1/exchangeInfo`, {
    timeout: 10_000,
    headers: JSON_HEADERS,
  });
  return res.data.symbols.find(s => s.symbol === symbol) || null;
}

/**
 * Private: fetch futures account balance.
 */
export async function fetchFuturesBalance() {
  const qs = buildSignedParams({}, BINANCE_API_SECRET);
  const res = await axios.get(`${BASE}/fapi/v2/balance?${qs}`, {
    timeout: 8_000,
    headers: headers(),
  });
  const usdt = res.data.find(b => b.asset === 'USDT');
  return {
    availableBalance: Number(usdt?.availableBalance || 0),
    walletBalance: Number(usdt?.walletBalance || 0),
    unrealizedPnl: Number(usdt?.crossUnPnl || 0),
  };
}

/**
 * Private: fetch open positions from Binance.
 */
export async function fetchOpenFuturesPositions() {
  const qs = buildSignedParams({}, BINANCE_API_SECRET);
  const res = await axios.get(`${BASE}/fapi/v2/positionRisk?${qs}`, {
    timeout: 8_000,
    headers: headers(),
  });
  return res.data.filter(p => Number(p.positionAmt) !== 0);
}
