/**
 * Every USDⓈ-M perpetual symbol Binance ever listed — including delisted ones —
 * with its trading range, so the backtest universe has no survivorship bias.
 *
 * Sources:
 *   - data.binance.vision: one directory per symbol under daily/klines (also
 *     long-delisted symbols); the first/last daily 1d file gives the range.
 *   - exchangeInfo (current): status, underlyingType, onboardDate. Symbols
 *     absent from it have underlyingType null (unknown).
 *
 * Cached in <cache>/universe/symbols.json. A delisted symbol whose last day is
 * over a week old is final and never listed again; others are re-listed
 * incrementally (S3 marker = last key seen).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CACHE_DIR } from './klineStore.js';
import { listS3, mapLimit, UM_DAILY_KLINES, UM_MONTHLY_KLINES, DAY_MS, dayStart, isoDay, defaultHttp } from './vision.js';

export const DEFAULT_REGISTRY_FILE = path.join(path.dirname(DEFAULT_CACHE_DIR), 'universe', 'symbols.json');

/** Perpetual names only: delivery contracts carry an expiry suffix (BTCUSDT_250328). */
export const isPerpetualName = s => /^[A-Z0-9]+$/.test(s);

const DAY_KEY = /-1d-(\d{4}-\d{2}-\d{2})\.zip$/;
const MONTH_KEY = /-1d-(\d{4}-\d{2})\.zip$/;

const dayOf = key => { const m = key.match(DAY_KEY); return m ? Date.parse(`${m[1]}T00:00:00Z`) : null; };

/**
 * First/last archived day of a symbol without listing every daily file: the
 * monthly 1d listing (~2 keys per month) gives the months; then one tiny
 * listing for the first daily file of the first month and one for the days of
 * the last month onwards.
 */
async function archivedRange(symbol, http) {
  const dailyPrefix = `${UM_DAILY_KLINES}${symbol}/1d/`;
  const months = (await listS3(`${UM_MONTHLY_KLINES}${symbol}/1d/`, { http, delimiter: false })).keys
    .map(k => k.match(MONTH_KEY)?.[1]).filter(Boolean).sort();
  const dailyAfter = (marker, maxKeys) => listS3(dailyPrefix, { http, delimiter: false, marker, maxKeys })
    .then(r => r.keys.filter(k => DAY_KEY.test(k)).sort());
  if (!months.length) {
    const keys = await dailyAfter('');
    return { firstDayMs: keys.length ? dayOf(keys[0]) : null, lastDayMs: keys.length ? dayOf(keys.at(-1)) : null, lastKey: keys.at(-1) || '' };
  }
  const monthMarker = m => `${dailyPrefix}${symbol}-1d-${m}-00`;
  const [firstKeys, lastKeys] = await Promise.all([dailyAfter(monthMarker(months[0]), 2), dailyAfter(monthMarker(months.at(-1)))]);
  const monthStart = Date.parse(`${months[0]}-01T00:00:00Z`);
  const firstDaily = firstKeys.length ? dayOf(firstKeys[0]) : null;
  const lastMonthEnd = Date.UTC(Number(months.at(-1).slice(0, 4)), Number(months.at(-1).slice(5, 7)), 1) - DAY_MS;
  return {
    // daily files may start later than monthly ones: month precision is enough then
    firstDayMs: firstDaily !== null && isoDay(firstDaily).startsWith(months[0]) ? firstDaily : monthStart,
    lastDayMs: lastKeys.length ? dayOf(lastKeys.at(-1)) : lastMonthEnd,
    lastKey: lastKeys.at(-1) || '',
  };
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

async function writeJson(file, body) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(body, null, 1));
  await fs.rename(tmp, file);
}

/**
 * @param {object} opts
 * @param {object[]} opts.exchangeInfoSymbols - GET /fapi/v1/exchangeInfo `symbols` (current)
 * @param {Function} [opts.http] - see vision.js defaultHttp
 * @param {string} [opts.file]
 * @param {number} [opts.nowMs]
 * @returns {Promise<Map<string, object>>} symbol => { symbol, firstDayMs, lastDayMs, listed, delisted,
 *   status, underlyingType, contractType, onboardDate, deliveryDate }
 */
export async function buildSymbolRegistry({ exchangeInfoSymbols = [], http = defaultHttp, file = DEFAULT_REGISTRY_FILE, nowMs = Date.now(), concurrency = 8, log = () => {} } = {}) {
  const cached = (await readJson(file))?.symbols || {};
  const { prefixes } = await listS3(UM_DAILY_KLINES, { http });
  const archived = new Set(prefixes.map(p => p.slice(UM_DAILY_KLINES.length).replace(/\/$/, '')).filter(isPerpetualName));
  const info = new Map(exchangeInfoSymbols.filter(s => String(s.contractType || '').includes('PERPETUAL')).map(s => [s.symbol, s]));
  const names = [...new Set([...archived, ...info.keys()])].filter(isPerpetualName).sort();
  log(`[universe] ${names.length} perpetual symbols (${archived.size} in the archive, ${info.size} in exchangeInfo)`);

  const entries = await mapLimit(names, concurrency, async (symbol) => {
    const prev = cached[symbol];
    let { firstDayMs = null, lastDayMs = null, lastKey = '' } = prev || {};
    const final = prev?.delisted && prev.lastDayMs !== null && prev.lastDayMs < nowMs - 7 * DAY_MS;
    if (!final && archived.has(symbol)) {
      if (lastKey) {
        // Known symbol: only the daily files added since the last listing
        const keys = (await listS3(`${UM_DAILY_KLINES}${symbol}/1d/`, { http, delimiter: false, marker: lastKey })).keys.filter(k => DAY_KEY.test(k)).sort();
        if (keys.length) { lastDayMs = Math.max(lastDayMs ?? 0, dayOf(keys.at(-1))); lastKey = keys.at(-1); }
      } else {
        ({ firstDayMs, lastDayMs, lastKey } = await archivedRange(symbol, http));
      }
    }
    const ex = info.get(symbol);
    const listed = ex?.status === 'TRADING';
    if (ex?.onboardDate) firstDayMs = Math.min(firstDayMs ?? Infinity, dayStart(Number(ex.onboardDate)));
    if (listed) lastDayMs = dayStart(nowMs); // the archive lags a day or two behind
    return {
      symbol, firstDayMs, lastDayMs, lastKey, listed,
      delisted: !listed && ex?.status !== 'PENDING_TRADING',
      status: ex?.status ?? null,
      underlyingType: ex?.underlyingType ?? null,
      contractType: ex?.contractType ?? null,
      onboardDate: ex?.onboardDate ?? null,
      deliveryDate: ex?.deliveryDate ?? null,
    };
  });

  await writeJson(file, { updatedAt: nowMs, symbols: Object.fromEntries(entries.map(e => [e.symbol, e])) });
  return new Map(entries.filter(e => e.firstDayMs !== null).map(e => [e.symbol, e]));
}

/** True if the symbol traded at any time in [fromMs, toMs]. */
export function tradedBetween(entry, fromMs, toMs) {
  return entry.firstDayMs !== null && entry.firstDayMs <= toMs && entry.lastDayMs + DAY_MS > fromMs;
}

/** One line per symbol: range, listed/delisted, underlyingType. */
export function formatRegistry(registry) {
  const rows = [...registry.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const delisted = rows.filter(r => r.delisted).length;
  return [
    `${rows.length} USDⓈ-M perpetual symbols (${rows.length - delisted} trading, ${delisted} delisted/not trading)`,
    ...rows.map(r => `${r.symbol.padEnd(20)} ${isoDay(r.firstDayMs)} -> ${r.listed ? 'now       ' : isoDay(r.lastDayMs)}  ${(r.status || 'not in exchangeInfo').padEnd(20)} ${r.underlyingType || 'underlyingType unknown'}`),
  ].join('\n');
}
