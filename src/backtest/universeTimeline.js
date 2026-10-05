/**
 * Point-in-time universe for the backtest: at every 15m close t the live
 * rules (src/universe/rules.js) are applied to a 24h-ticker snapshot built
 * from each symbol's last 24h of CLOSED 15m candles (openTime >= t - 24h,
 * closeTime < t; at most 96 candles, fewer around listing or exchange holes).
 * No lookahead: nothing at or after t is used.
 *
 * Membership is recorded as enter/exit events and per-symbol intervals
 * [enterMs, exitMs) — exitMs null while still in at the end of the run.
 */

import {
  UNIVERSE_RULES, universeCriteria, passesCriteria, selectUniverse, diffUniverse, ticker24hFromKlines15m, isEligibleSymbolName,
} from '../universe/rules.js';

const M15 = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * @param {object} opts
 * @param {object[]} opts.candidates - registry entries { symbol, firstDayMs, lastDayMs, underlyingType }
 * @param {number} opts.dateFromMs - first tick (the runner's t)
 * @param {number} opts.dateToMs - last tick (inclusive)
 * @param {(symbol: string, fromMs: number, toMs: number) => Promise<object[]>} opts.load15m - 15m candles with openTime in [fromMs, toMs]
 * @param {string[]} [opts.core] - pinned + env symbols: always in
 * @param {object} [opts.rules]
 * @param {'reject'|'coin'} [opts.unknownUnderlying] - symbols with no exchangeInfo (e.g. long delisted):
 *   'reject' (default, strict COIN allowlist) or treat as COIN
 * @param {number} [opts.chunkMs]
 * @returns {Promise<UniverseTimeline>}
 */
export async function computeUniverseTimeline({
  candidates, dateFromMs, dateToMs, load15m, core = [], rules = UNIVERSE_RULES,
  unknownUnderlying = 'reject', chunkMs = 7 * DAY_MS, tickMs = M15, log = () => {},
}) {
  const info = new Map(candidates.map(c => [c.symbol, {
    underlyingType: c.underlyingType ?? (unknownUnderlying === 'coin' ? 'COIN' : null),
  }]));
  const criteria = universeCriteria(rules);
  const anyType = { ...criteria, coinOnly: false };
  const pool = candidates.filter(c => isEligibleSymbolName(c.symbol));
  const excludedUnknownType = new Set();

  const events = [];
  const intervals = new Map();
  let prev = [];
  let ticks = 0, sizeSum = 0, maxSize = 0;

  for (let c0 = dateFromMs; c0 <= dateToMs; c0 += chunkMs) {
    const c1 = Math.min(c0 + chunkMs, dateToMs + tickMs); // ticks in [c0, c1)
    const tickTimes = [];
    for (let t = c0; t < c1; t += tickMs) tickTimes.push(t);
    const buckets = tickTimes.map(() => []);

    for (const cand of pool) {
      if (cand.firstDayMs > c1 || cand.lastDayMs + DAY_MS <= c0 - DAY_MS) continue;
      const candles = await load15m(cand.symbol, c0 - DAY_MS, c1 - 1);
      if (!candles.length) continue;
      let lo = 0, hi = 0;
      for (let i = 0; i < tickTimes.length; i++) {
        const t = tickTimes[i];
        while (hi < candles.length && candles[hi].closeTime < t) hi++;
        while (lo < hi && candles[lo].openTime < t - DAY_MS) lo++;
        if (hi === lo) continue;
        const ticker = { symbol: cand.symbol, ...ticker24hFromKlines15m(candles.slice(lo, hi)) };
        const exInfo = info.get(cand.symbol);
        if (passesCriteria(ticker, criteria, exInfo)) buckets[i].push(ticker);
        else if (exInfo.underlyingType === null && passesCriteria(ticker, anyType, exInfo)) excludedUnknownType.add(cand.symbol);
      }
    }

    for (let i = 0; i < tickTimes.length; i++) {
      const t = tickTimes[i];
      const { symbols } = selectUniverse(buckets[i], { exchangeInfo: info, envDefaults: core, rules });
      const { added, removed } = diffUniverse(prev, symbols);
      for (const s of added) {
        events.push({ t, symbol: s, type: 'enter' });
        if (!intervals.has(s)) intervals.set(s, []);
        intervals.get(s).push([t, null]);
      }
      for (const s of removed) {
        events.push({ t, symbol: s, type: 'exit' });
        intervals.get(s).at(-1)[1] = t;
      }
      prev = symbols;
      ticks++; sizeSum += symbols.length; maxSize = Math.max(maxSize, symbols.length);
    }
    log(`[universe] ${new Date(c0).toISOString().slice(0, 10)}: ${prev.length} symbols, ${intervals.size} seen so far`);
  }

  return new UniverseTimeline({ mode: 'dynamic', intervals, events, core, excludedUnknownType: [...excludedUnknownType].sort(),
    stats: { ticks, avgSize: ticks ? sizeSum / ticks : 0, maxSize }, dateFromMs, dateToMs, tickMs });
}

export class UniverseTimeline {
  constructor({ mode = 'dynamic', intervals, events = [], core = [], excludedUnknownType = [], stats = {}, dateFromMs, dateToMs, tickMs = M15 }) {
    this.mode = mode;
    this.intervals = intervals; // Map symbol => [[enterMs, exitMs|null], ...] sorted
    this.events = events;
    this.core = [...core];
    this.excludedUnknownType = excludedUnknownType;
    this.stats = stats;
    this.dateFromMs = dateFromMs;
    this.dateToMs = dateToMs;
    this.endMs = dateToMs + tickMs; // open intervals end here
  }

  /** Fixed universe: every symbol in for the whole run. */
  static fixed(symbols, dateFromMs, dateToMs, tickMs = M15) {
    return new UniverseTimeline({
      mode: 'fixed',
      intervals: new Map(symbols.map(s => [s, [[dateFromMs, null]]])),
      events: symbols.map(s => ({ t: dateFromMs, symbol: s, type: 'enter' })),
      core: symbols, dateFromMs, dateToMs, tickMs,
    });
  }

  symbols() { return [...this.intervals.keys()]; }

  isMember(symbol, t) {
    const iv = this.intervals.get(symbol);
    if (!iv) return false;
    let lo = 0, hi = iv.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [a, b] = iv[mid];
      if (t < a) hi = mid - 1;
      else if (b !== null && t >= b) lo = mid + 1;
      else return true;
    }
    return false;
  }

  /** Intervals with open ends closed at the end of the run. */
  closedIntervals(symbol) {
    return (this.intervals.get(symbol) || []).map(([a, b]) => [a, b ?? this.endMs]);
  }

  totalMs(symbol) {
    return this.closedIntervals(symbol).reduce((n, [a, b]) => n + (b - a), 0);
  }

  /** JSON-safe summary for backtest_runs.params_json (events as [t, symbol, '+'|'-']). */
  toJSON() {
    return {
      mode: this.mode,
      core: this.core,
      stats: this.stats,
      excludedUnknownType: this.excludedUnknownType,
      members: this.symbols().map(s => ({ symbol: s, totalMs: this.totalMs(s), intervals: this.closedIntervals(s) })),
      events: this.events.map(e => [e.t, e.symbol, e.type === 'enter' ? '+' : '-']),
    };
  }
}
