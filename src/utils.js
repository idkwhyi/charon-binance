import { createHmac } from 'node:crypto';

export function now() {
  return Date.now();
}

export function json(obj) {
  return JSON.stringify(obj);
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function pruneSeen(map, ttlMs) {
  const t = now();
  for (const [k, v] of map) {
    if (t - v > ttlMs) map.delete(k);
  }
}

/**
 * HMAC-SHA256 signature for Binance API
 */
export function hmacSign(secret, queryString) {
  return createHmac('sha256', secret).update(queryString).digest('hex');
}

/**
 * Build a signed query string for Binance Futures API.
 * @param {Record<string,string|number>} params
 * @param {string} secret
 */
export function buildSignedParams(params, secret) {
  const p = { ...params, timestamp: now() };
  const qs = Object.entries(p).map(([k, v]) => `${k}=${v}`).join('&');
  const signature = hmacSign(secret, qs);
  return `${qs}&signature=${signature}`;
}

/**
 * Calculate RSI from an array of closing prices.
 * @param {number[]} closes - Oldest first
 * @param {number} period
 */
export function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Calculate EMA from an array of values.
 * @param {number[]} values - Oldest first
 * @param {number} period
 */
export function calcEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Return first finite positive number from args.
 */
export function firstPositive(...args) {
  for (const v of args) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * Failure tracker: sends alert after N consecutive failures.
 */
export function makeFailureTracker(name, alertFn, maxFails = 3) {
  let fails = 0;
  return async (fn) => {
    try {
      await fn();
      fails = 0;
    } catch (err) {
      fails++;
      console.log(`[${name}] error (${fails}/${maxFails}): ${err.message}`);
      if (fails >= maxFails) {
        await alertFn(`⚠️ <b>${name}</b> failed ${fails} times in a row.\nLast: ${err.message}`).catch(() => {});
        fails = 0;
      }
    }
  };
}

/**
 * Parse strict JSON from LLM text (strips markdown code fences).
 */
export function strictJsonFromText(text) {
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(clean);
}
