/**
 * 1m candles for backtest exits, loaded one UTC day at a time from the kline
 * cache (downloading a day only when a position needs it) instead of holding
 * the whole range of every symbol in memory.
 */

import { getKlinesCached } from './klineStore.js';
import { lowerBoundByOpenTime } from './candles.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const dayStart = ms => Math.floor(ms / DAY_MS) * DAY_MS;

export class MinuteStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir - kline cache dir
   * @param {(symbol: string) => Function} opts.fetchRangeFor - fetchRange per symbol (REST or archive)
   * @param {number} [opts.nowMs]
   * @param {number} [opts.keepDays] - days kept in memory per symbol
   */
  constructor({ dir, fetchRangeFor, nowMs = Date.now(), keepDays = 3 }) {
    Object.assign(this, { dir, fetchRangeFor, nowMs, keepDays });
    this.days = new Map(); // symbol => Map(dayMs => Promise<candles>)
  }

  day(symbol, d) {
    if (!this.days.has(symbol)) this.days.set(symbol, new Map());
    const m = this.days.get(symbol);
    if (!m.has(d)) {
      m.set(d, getKlinesCached(symbol, '1m', d, d + DAY_MS - 1, { dir: this.dir, fetchRange: this.fetchRangeFor(symbol), nowMs: this.nowMs })
        .then(r => r.candles));
      while (m.size > this.keepDays) m.delete(m.keys().next().value); // oldest first (insertion order)
    }
    return m.get(d);
  }

  /** 1m candles that opened in [fromMs, toMs). */
  async between(symbol, fromMs, toMs) {
    if (!(toMs > fromMs)) return [];
    const out = [];
    for (let d = dayStart(fromMs); d < toMs && d <= this.nowMs; d += DAY_MS) {
      const ks = await this.day(symbol, d);
      out.push(...ks.slice(lowerBoundByOpenTime(ks, fromMs), lowerBoundByOpenTime(ks, toMs)));
    }
    return out;
  }

  /** Close of the latest 1m candle that closed before tMs (looks back up to `lookbackDays`). */
  async lastClosedPrice(symbol, tMs, lookbackDays = 2) {
    for (let d = dayStart(Math.min(tMs, this.nowMs)), n = 0; n <= lookbackDays; d -= DAY_MS, n++) {
      const ks = await this.day(symbol, d);
      for (let i = lowerBoundByOpenTime(ks, tMs) - 1; i >= 0; i--) {
        if (ks[i].closeTime < tMs) return ks[i].close;
      }
    }
    return null;
  }

  /** Forget a symbol's days (no open position needs them any more). */
  release(symbol) {
    this.days.delete(symbol);
  }
}
