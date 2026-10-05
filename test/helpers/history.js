import axios from 'axios';

export const M1 = 60_000, M15 = 15 * M1, H1 = 60 * M1;
const k = (openTime, step, o = {}) => ({ openTime, open: 100, high: 100.05, low: 99.95, close: 100, volume: 1, quoteVolume: 1e6, closeTime: openTime + step - 1, ...o });

/**
 * Stub Binance history. plan: { SYMBOL: [{ spikeAt, stopOut?, short? }] } — a 15m volume
 * spike at spikeAt (bearish body if short); with stopOut, a 1m wick through a 1.5% SL
 * 5 minutes after the entry tick.
 */
export function stubHistory(plan, { holes = {} } = {}) {
  // holes: { '15m': [openTime, ...], '1h': [...] } — candles Binance does not have (any symbol)
  const original = axios.get;
  axios.get = async (url, { params = {} } = {}) => {
    if (url.includes('fundingRate')) return { data: [] };
    const step = { '1m': M1, '15m': M15, '1h': H1 }[params.interval];
    const events = plan[params.symbol] || [];
    const rows = [];
    for (let o = Math.ceil(params.startTime / step) * step; o <= params.endTime && rows.length < params.limit; o += step) {
      if ((holes[params.interval] || []).includes(o)) continue;
      let c = k(o, step);
      for (const e of events) {
        if (params.interval === '15m' && o === e.spikeAt) c = k(o, step, { open: e.short ? 100.1 : 99.9, volume: 1000 });
        const entryT = e.spikeAt + M15;
        if (params.interval === '1m' && e.stopOut && o === entryT + 5 * M1) {
          c = e.short ? k(o, step, { open: 100.5, high: 102, low: 100.4, close: 101.8 }) : k(o, step, { open: 99.5, high: 99.6, low: 98, close: 98.2 });
        }
      }
      rows.push([c.openTime, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume), c.closeTime, String(c.quoteVolume)]);
    }
    return { data: rows };
  };
  return () => { axios.get = original; };
}

/** Open interest source that always has a large OI, for tests not about the OI filter. */
export function ampleOpenInterest() {
  return {
    at: async () => ({ t: 0, sumOpenInterest: 1e12, sumOpenInterestValue: 1e14 }),
    coverage: async () => ({ lookups: 0, found: 0, missing: 0, daysRequested: 0, daysWithData: 0, bySymbol: {} }),
  };
}
