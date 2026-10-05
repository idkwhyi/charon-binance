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
import { listS3, mapLimit, UM_DAILY_KLINES, DAY_MS, dayStart, isoDay, defaultHttp } from './vision.js';

export const DEFAULT_REGISTRY_FILE = path.join(path.dirname(DEFAULT_CACHE_DIR), 'universe', 'symbols.json');

/** Perpetual names only: delivery contracts carry an expiry suffix (BTCUSDT_250328). */
export const isPerpetualName = s => /^[A-Z0-9]+$/.test(s);

const DAY_KEY = /-1d-(\d{4}-\d{2}-\d{2})\.zip$/;

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
      const { keys } = await listS3(`${UM_DAILY_KLINES}${symbol}/1d/`, { http, delimiter: false, marker: lastKey });
      for (const key of keys) {
        const m = key.match(DAY_KEY);
        if (!m) continue;
        const d = Date.parse(`${m[1]}T00:00:00Z`);
        if (firstDayMs === null || d < firstDayMs) firstDayMs = d;
        if (lastDayMs === null || d > lastDayMs) lastDayMs = d;
      }
      if (keys.length) lastKey = keys.sort().at(-1);
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
