/**
 * Historical open interest for the backtest, from the data.binance.vision
 * metrics archive (5-minute rows: sum_open_interest in contracts,
 * sum_open_interest_value in USDT). Cached per UTC day:
 *   <dir>/<SYMBOL>/<YYYY-MM-DD>.json  { symbol, day, fetchedAt, missing, rows: [[t, oi, oiValue], ...] }
 *
 * A day the archive has no file for is cached as `missing` only once it is
 * old enough to have been published (PUBLISH_LAG_MS); until then it is retried.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CACHE_DIR } from './klineStore.js';
import { defaultHttp, fetchZipCsv, parseMetricsCsv, dailyMetricsPath, DAY_MS, dayStart, isoDay } from './vision.js';

export const DEFAULT_METRICS_DIR = path.join(path.dirname(DEFAULT_CACHE_DIR), 'metrics');
export const OI_MAX_AGE_MS = 30 * 60_000; // a value older than this at signal time counts as missing
const PUBLISH_LAG_MS = 3 * DAY_MS;

const file = (dir, symbol, dayMs) => path.join(dir, symbol, `${isoDay(dayMs)}.json`);

async function readDay(dir, symbol, dayMs) {
  try { return JSON.parse(await fs.readFile(file(dir, symbol, dayMs), 'utf8')); } catch { return null; }
}

async function writeDay(dir, symbol, dayMs, body) {
  const f = file(dir, symbol, dayMs);
  await fs.mkdir(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(body));
  await fs.rename(tmp, f);
}

/**
 * Metrics rows of one UTC day, or null if the archive has none.
 * @returns {Promise<Array<{t, sumOpenInterest, sumOpenInterestValue}>|null>}
 */
export async function getMetricsDay(symbol, dayMs, { dir = DEFAULT_METRICS_DIR, http = defaultHttp, nowMs = Date.now() } = {}) {
  const cached = await readDay(dir, symbol, dayMs);
  const fromRows = rows => rows.map(([t, oi, v]) => ({ t, sumOpenInterest: oi, sumOpenInterestValue: v }));
  if (cached) return cached.missing ? null : fromRows(cached.rows);

  const csv = await fetchZipCsv(dailyMetricsPath(symbol, dayMs), { http });
  if (csv === null) {
    if (nowMs > dayMs + PUBLISH_LAG_MS) await writeDay(dir, symbol, dayMs, { symbol, day: isoDay(dayMs), fetchedAt: nowMs, missing: true, rows: [] });
    return null;
  }
  const rows = parseMetricsCsv(csv);
  await writeDay(dir, symbol, dayMs, { symbol, day: isoDay(dayMs), fetchedAt: nowMs, missing: false,
    rows: rows.map(r => [r.t, r.sumOpenInterest, r.sumOpenInterestValue]) });
  return rows;
}

/** Latest row at or before tMs, if not older than maxAgeMs; else null. */
export function openInterestAt(rows, tMs, maxAgeMs = OI_MAX_AGE_MS) {
  let lo = 0, hi = (rows || []).length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].t <= tMs) lo = mid + 1; else hi = mid; }
  const row = lo > 0 ? rows[lo - 1] : null;
  return row && tMs - row.t <= maxAgeMs ? row : null;
}

/**
 * Point-in-time OI lookups with coverage stats.
 * @returns {{ at(symbol, tMs): Promise<object|null>, coverage(): object }}
 */
export function createOpenInterestSource({ dir = DEFAULT_METRICS_DIR, http = defaultHttp, nowMs = Date.now(), maxAgeMs = OI_MAX_AGE_MS } = {}) {
  const days = new Map(); // `${symbol}:${day}` => Promise<rows|null>
  const bySymbol = {};
  const day = (symbol, d) => {
    const key = `${symbol}:${d}`;
    if (!days.has(key)) days.set(key, getMetricsDay(symbol, d, { dir, http, nowMs }));
    return days.get(key);
  };
  return {
    async at(symbol, tMs) {
      const d = dayStart(tMs);
      let row = openInterestAt(await day(symbol, d), tMs, maxAgeMs);
      if (!row && tMs - d < maxAgeMs) row = openInterestAt(await day(symbol, d - DAY_MS), tMs, maxAgeMs);
      const s = bySymbol[symbol] || (bySymbol[symbol] = { lookups: 0, found: 0 });
      s.lookups++;
      if (row) s.found++;
      return row;
    },
    async coverage() {
      const lookups = Object.values(bySymbol).reduce((n, s) => n + s.lookups, 0);
      const found = Object.values(bySymbol).reduce((n, s) => n + s.found, 0);
      const settled = await Promise.all([...days.values()]);
      return {
        lookups, found, missing: lookups - found,
        daysRequested: settled.length, daysWithData: settled.filter(Boolean).length,
        bySymbol,
      };
    },
  };
}
