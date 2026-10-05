/**
 * Inputs for a backtest with the dynamic (point-in-time) universe:
 *   1. registry of every USDⓈ-M perpetual incl. delisted (symbolRegistry.js)
 *   2. 15m candles of every eligible symbol over the run (+24h) — the only
 *      data needed for ALL symbols, used to compute the universe
 *   3. the universe timeline (universeTimeline.js)
 * Full 1h/15m/1m data is then loaded by the runner only for symbols while they
 * are in the universe (plus warmup), through fetchRangeFor(symbol).
 */

import { fetchKlinesRange } from '../enrichment/binance.js';
import { isEligibleSymbolName, UNIVERSE_RULES } from '../universe/rules.js';
import { getKlinesCached, contiguousRuns, DEFAULT_CACHE_DIR } from './klineStore.js';
import { buildSymbolRegistry, tradedBetween, DEFAULT_REGISTRY_FILE } from './symbolRegistry.js';
import { computeUniverseTimeline } from './universeTimeline.js';
import { fetchKlinesRangeVision, defaultHttp, mapLimit, DAY_MS, dayStart } from './vision.js';

/** The archive publishes a day's files with a lag; newer days come from REST. */
export const ARCHIVE_LAG_DAYS = 2;

/**
 * fetchRange for one symbol (same signature as fetchKlinesRange): clipped to
 * the symbol's trading range; data.binance.vision for days older than the
 * archive lag (works for delisted symbols), REST for newer days and for days
 * the archive is missing while the symbol is still listed.
 */
export function hybridFetchRange(entry, { http = defaultHttp, restFetchRange = fetchKlinesRange, nowMs = Date.now() } = {}) {
  return async (symbol, interval, startMs, endMs) => {
    const lo = Math.max(startMs, entry?.firstDayMs ?? startMs);
    const hi = Math.min(endMs, entry ? entry.lastDayMs + DAY_MS - 1 : endMs);
    if (lo > hi) return [];
    const listed = entry ? entry.listed : true;
    const archiveEnd = Math.min(hi, dayStart(nowMs) - ARCHIVE_LAG_DAYS * DAY_MS - 1);
    const out = [];
    if (lo <= archiveEnd) {
      const archived = await fetchKlinesRangeVision(symbol, interval, lo, archiveEnd, { http, nowMs });
      out.push(...archived);
      if (listed) {
        const have = new Set(archived.map(k => dayStart(k.openTime)));
        const holes = [];
        for (let d = dayStart(lo); d <= archiveEnd; d += DAY_MS) if (!have.has(d)) holes.push(d);
        for (const [a, b] of contiguousRuns(holes)) {
          out.push(...await restFetchRange(symbol, interval, Math.max(lo, a), Math.min(archiveEnd, b + DAY_MS - 1)));
        }
      }
    }
    const restFrom = Math.max(lo, archiveEnd + 1);
    if (listed && restFrom <= hi) out.push(...await restFetchRange(symbol, interval, restFrom, hi));
    return out.sort((a, b) => a.openTime - b.openTime);
  };
}

/**
 * @param {object} opts
 * @param {number} opts.dateFromMs
 * @param {number} opts.dateToMs
 * @param {string[]} opts.core - pinned + env symbols (always in the universe)
 * @param {object[]} opts.exchangeInfoSymbols - current exchangeInfo `symbols`
 * @param {'reject'|'coin'} [opts.unknownUnderlying]
 * @returns {Promise<{ timeline, registry, fetchRangeFor: (symbol) => Function, download: object }>}
 */
export async function prepareDynamicUniverse({
  dateFromMs, dateToMs, core = [], exchangeInfoSymbols = [], unknownUnderlying = 'coin', rules = UNIVERSE_RULES,
  cacheDir = DEFAULT_CACHE_DIR, registryFile = DEFAULT_REGISTRY_FILE, http = defaultHttp,
  restFetchRange = fetchKlinesRange, nowMs = Date.now(), concurrency = 4, log = console.log,
}) {
  const registry = await buildSymbolRegistry({ exchangeInfoSymbols, http, file: registryFile, nowMs, log });
  const fetchers = new Map();
  const fetchRangeFor = (symbol) => {
    if (!fetchers.has(symbol)) fetchers.set(symbol, hybridFetchRange(registry.get(symbol), { http, restFetchRange, nowMs }));
    return fetchers.get(symbol);
  };

  const fromMs = dateFromMs - DAY_MS; // 24h stats at the first tick
  const excluded = new Set(rules.excludeSymbols || []);
  const candidates = [...registry.values()].filter(e => isEligibleSymbolName(e.symbol) && !excluded.has(e.symbol) && tradedBetween(e, fromMs, dateToMs));
  const delisted = candidates.filter(e => e.delisted).length;
  log(`[universe] ${candidates.length} USDT perpetual(s) traded in the range (${delisted} since delisted); caching their 15m candles...`);

  const download = { symbols: candidates.length, downloadedDays: 0, cachedDays: 0 };
  let done = 0;
  await mapLimit(candidates, concurrency, async (e) => {
    const lo = Math.max(fromMs, e.firstDayMs), hi = Math.min(dateToMs, e.lastDayMs + DAY_MS - 1);
    const r = await getKlinesCached(e.symbol, '15m', lo, hi, { dir: cacheDir, fetchRange: fetchRangeFor(e.symbol), nowMs });
    download.downloadedDays += r.downloadedDays;
    download.cachedDays += r.cachedDays;
    if (++done % 25 === 0) log(`[universe]   15m cached for ${done}/${candidates.length} symbols`);
  });

  const timeline = await computeUniverseTimeline({
    candidates, dateFromMs, dateToMs, core, unknownUnderlying, rules, log,
    load15m: (symbol, a, b) => getKlinesCached(symbol, '15m', a, b, { dir: cacheDir, fetchRange: fetchRangeFor(symbol), nowMs }).then(r => r.candles),
  });
  timeline.delisted = timeline.symbols().filter(s => registry.get(s)?.delisted);
  log(`[universe] ${timeline.symbols().length} symbol(s) were in the universe at some point (${timeline.delisted.length} since delisted), ${timeline.events.length} enter/exit events`);
  return { timeline, registry, fetchRangeFor, download };
}
