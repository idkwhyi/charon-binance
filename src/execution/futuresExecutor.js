import axios from 'axios';
import {
  BINANCE_FUTURES_BASE_URL,
  BINANCE_API_KEY,
  BINANCE_API_SECRET,
  LIVE_MIN_USDT_RESERVE,
  TRADE_AMOUNT_USDT,
  MARGIN_TYPE,
} from '../config.js';
import { buildSignedParams } from '../utils.js';
import { fetchFuturesBalance, fetchExchangeInfo } from '../enrichment/binance.js';

const BASE = BINANCE_FUTURES_BASE_URL;

function headers() {
  return {
    'X-MBX-APIKEY': BINANCE_API_KEY,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

/**
 * Set leverage for a symbol.
 */
async function setLeverage(symbol, leverage) {
  const qs = buildSignedParams({ symbol, leverage }, BINANCE_API_SECRET);
  await axios.post(`${BASE}/fapi/v1/leverage`, qs, { headers: headers(), timeout: 8_000 });
}

/**
 * Set margin type for a symbol.
 */
async function setMarginType(symbol, marginType) {
  try {
    const qs = buildSignedParams({ symbol, marginType }, BINANCE_API_SECRET);
    await axios.post(`${BASE}/fapi/v1/marginType`, qs, { headers: headers(), timeout: 8_000 });
  } catch (err) {
    // Binance returns error if already set to the same type — ignore
    if (!err.response?.data?.msg?.includes('No need')) throw err;
  }
}

/**
 * Get step size and tick size for a symbol from exchange info.
 */
async function getPrecision(symbol) {
  const info = await fetchExchangeInfo(symbol);
  if (!info) return { stepSize: 0.001, tickSize: 0.01, pricePrecision: 2, quantityPrecision: 3 };
  const lotFilter = info.filters?.find(f => f.filterType === 'LOT_SIZE');
  const priceFilter = info.filters?.find(f => f.filterType === 'PRICE_FILTER');
  return {
    stepSize: Number(lotFilter?.stepSize || 0.001),
    tickSize: Number(priceFilter?.tickSize || 0.01),
    pricePrecision: info.pricePrecision || 2,
    quantityPrecision: info.quantityPrecision || 3,
  };
}

/**
 * Round to step size.
 */
function roundToStep(value, step) {
  const precision = Math.round(-Math.log10(step));
  return parseFloat((Math.floor(value / step) * step).toFixed(precision));
}

/**
 * Execute a futures market buy/short:
 * 1. Validate free margin
 * 2. Set leverage + margin type
 * 3. Place MARKET order
 * 4. Place TP + SL stop orders
 */
export async function executeFuturesBuy(candidate, decision) {
  const { symbol, leverage, marginType } = candidate;
  const direction = decision.direction; // 'LONG' or 'SHORT'
  const side = direction === 'LONG' ? 'BUY' : 'SELL';
  const closeSide = direction === 'LONG' ? 'SELL' : 'BUY';

  // Check margin balance
  const balance = await fetchFuturesBalance();
  if (balance.availableBalance < LIVE_MIN_USDT_RESERVE) {
    throw new Error(`Insufficient margin: ${balance.availableBalance.toFixed(2)} USDT available, need ${LIVE_MIN_USDT_RESERVE} USDT reserve`);
  }

  const { stepSize, pricePrecision, quantityPrecision } = await getPrecision(symbol);

  await setMarginType(symbol, marginType || MARGIN_TYPE);
  await setLeverage(symbol, leverage);

  // Calculate quantity from USDT amount + leverage
  const markPrice = candidate.metrics.markPrice;
  const notionalUsdt = TRADE_AMOUNT_USDT * leverage;
  const rawQty = notionalUsdt / markPrice;
  const quantity = roundToStep(rawQty, stepSize);

  if (quantity <= 0) throw new Error(`Calculated quantity ${quantity} is invalid for ${symbol}`);

  // Place MARKET entry order
  const entryQs = buildSignedParams({
    symbol,
    side,
    type: 'MARKET',
    quantity,
    positionSide: 'BOTH', // One-way mode
  }, BINANCE_API_SECRET);

  const entryRes = await axios.post(`${BASE}/fapi/v1/order`, entryQs, {
    headers: headers(),
    timeout: 15_000,
  });
  const orderId = String(entryRes.data.orderId || '');
  const fillPrice = Number(entryRes.data.avgPrice || markPrice);

  console.log(`[executor] ${symbol} ${direction} ${quantity} @ ${fillPrice} (order ${orderId})`);

  // Use absolute SL/TP prices from OB meta if available (structure-based placement)
  // Otherwise fall back to percentage-based calculation
  let tpPrice, slPrice;

  const obMeta = candidate.signals?.meta || {};
  if (obMeta.stopLoss && obMeta.takeProfit) {
    // Structure-based: SL below Higher Low, TP at swing high/low
    slPrice = parseFloat(Number(obMeta.stopLoss).toFixed(pricePrecision));
    tpPrice = parseFloat(Number(obMeta.takeProfit).toFixed(pricePrecision));
    console.log(`[executor] Using structure-based SL=${slPrice} TP=${tpPrice} (from OB meta)`);
  } else {
    // Fallback: percentage-based
    const tpPct = Math.abs(decision.suggested_tp_percent) / 100;
    const slPct = Math.abs(decision.suggested_sl_percent) / 100;
    tpPrice = direction === 'LONG'
      ? parseFloat((fillPrice * (1 + tpPct)).toFixed(pricePrecision))
      : parseFloat((fillPrice * (1 - tpPct)).toFixed(pricePrecision));
    slPrice = direction === 'LONG'
      ? parseFloat((fillPrice * (1 - slPct)).toFixed(pricePrecision))
      : parseFloat((fillPrice * (1 + slPct)).toFixed(pricePrecision));
    console.log(`[executor] Using pct-based SL=${slPrice} TP=${tpPrice}`);
  }

  // Rough liquidation estimate (isolated margin, no funding)
  const liqPrice = direction === 'LONG'
    ? parseFloat((fillPrice * (1 - 1 / leverage * 0.9)).toFixed(pricePrecision))
    : parseFloat((fillPrice * (1 + 1 / leverage * 0.9)).toFixed(pricePrecision));

  // Place TAKE_PROFIT_MARKET order
  try {
    const tpQs = buildSignedParams({
      symbol,
      side: closeSide,
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: tpPrice,
      closePosition: 'true',
      positionSide: 'BOTH',
      timeInForce: 'GTE_GTC',
    }, BINANCE_API_SECRET);
    await axios.post(`${BASE}/fapi/v1/order`, tpQs, { headers: headers(), timeout: 10_000 });
    console.log(`[executor] TP set @ ${tpPrice}`);
  } catch (err) {
    console.log(`[executor] TP order failed: ${err.response?.data?.msg || err.message}`);
  }

  // Place STOP_MARKET order
  try {
    const slQs = buildSignedParams({
      symbol,
      side: closeSide,
      type: 'STOP_MARKET',
      stopPrice: slPrice,
      closePosition: 'true',
      positionSide: 'BOTH',
      timeInForce: 'GTE_GTC',
    }, BINANCE_API_SECRET);
    await axios.post(`${BASE}/fapi/v1/order`, slQs, { headers: headers(), timeout: 10_000 });
    console.log(`[executor] SL set @ ${slPrice}`);
  } catch (err) {
    console.log(`[executor] SL order failed: ${err.response?.data?.msg || err.message}`);
  }

  return { orderId, fillPrice, tpPrice, slPrice, liqPrice, quantity };
}

/**
 * Close a live position with a MARKET order.
 */
export async function executeFuturesSell(symbol, direction, quantity) {
  const side = direction === 'LONG' ? 'SELL' : 'BUY';
  const qs = buildSignedParams({
    symbol,
    side,
    type: 'MARKET',
    quantity,
    positionSide: 'BOTH',
    reduceOnly: 'true',
  }, BINANCE_API_SECRET);
  const res = await axios.post(`${BASE}/fapi/v1/order`, qs, {
    headers: headers(),
    timeout: 15_000,
  });
  return {
    orderId: String(res.data.orderId || ''),
    fillPrice: Number(res.data.avgPrice || 0),
  };
}

/**
 * Cancel all open orders for a symbol (cleanup after position closed).
 */
export async function cancelAllOrders(symbol) {
  try {
    const qs = buildSignedParams({ symbol }, BINANCE_API_SECRET);
    await axios.delete(`${BASE}/fapi/v1/allOpenOrders?${qs}`, {
      headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
      timeout: 8_000,
    });
  } catch (err) {
    console.log(`[executor] cancelAllOrders ${symbol}: ${err.message}`);
  }
}
