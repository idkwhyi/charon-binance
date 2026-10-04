/**
 * Local on-disk cache of historical klines for the backtest, so repeated
 * runs only download what is missing.
 *
 * Layout: <dir>/<SYMBOL>/<interval>/<YYYY-MM-DD>.json, one UTC day per file:
 *   { symbol, interval, day, fetchedAt, complete, candles: [[openTime, o, h, l, c, v, closeTime, qv], ...] }
 *
 * A day is `complete` once it was fetched after the day ended — closed
 * history never changes, so it is never downloaded again (even if the
 * exchange itself has a hole that day). Days not cached yet, or fetched
 * while still in progress, are re-downloaded, merged into contiguous ranges.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_CACHE_DIR = process.env.BACKTEST_CACHE_DIR || path.resolve('.cache/klines');

const dayStart = ms => Math.floor(ms / DAY_MS) * DAY_MS;
const dayKey = ms => new Date(dayStart(ms)).toISOString().slice(0, 10);
const toRow = k => [k.openTime, k.open, k.high, k.low, k.close, k.volume, k.closeTime, k.quoteVolume];
const fromRow = r => ({ openTime: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5], closeTime: r[6], quoteVolume: r[7] });

function filePath(dir, symbol, interval, dayMs) {
  return path.join(dir, symbol, interval, `${dayKey(dayMs)}.json`);
}

async function readDay(dir, symbol, interval, dayMs) {
  try {
    return JSON.parse(await fs.readFile(filePath(dir, symbol, interval, dayMs), 'utf8'));
  } catch {
    return null;
  }
}

async function writeDay(dir, symbol, interval, dayMs, candles, fetchedAt) {
  const file = filePath(dir, symbol, interval, dayMs);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = { symbol, interval, day: dayKey(dayMs), fetchedAt, complete: fetchedAt > dayMs + DAY_MS - 1, candles: candles.map(toRow) };
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(body));
  await fs.rename(tmp, file); // atomic: a crashed run never leaves a half-written day
}

/** Contiguous runs of day starts, e.g. [d1,d2,d4] -> [[d1,d2],[d4,d4]]. */
export function contiguousRuns(days) {
  const runs = [];
  for (const d of days) {
    const last = runs[runs.length - 1];
    if (last && d - last[1] === DAY_MS) last[1] = d; else runs.push([d, d]);
  }
  return runs;
}

/**
 * Klines with openTime in [startMs, endMs], served from the local cache and
 * downloading only the missing days.
 * @param {object} [opts]
 * @param {string} [opts.dir]
 * @param {Function} opts.fetchRange - (symbol, interval, startMs, endMs) => candles (fetchKlinesRange)
 * @param {number} [opts.nowMs]
 * @returns {Promise<{ candles: Array, downloadedDays: number, cachedDays: number }>}
 */
export async function getKlinesCached(symbol, interval, startMs, endMs, { dir = DEFAULT_CACHE_DIR, fetchRange, nowMs = Date.now() } = {}) {
  const lastDay = dayStart(Math.min(endMs, nowMs));
  const byDay = new Map();
  const missing = [];
  for (let d = dayStart(startMs); d <= lastDay; d += DAY_MS) {
    const cached = await readDay(dir, symbol, interval, d);
    if (cached?.complete) byDay.set(d, cached.candles.map(fromRow));
    else missing.push(d);
  }

  for (const [from, to] of contiguousRuns(missing)) {
    const fetched = await fetchRange(symbol, interval, from, Math.min(to + DAY_MS - 1, nowMs));
    const split = new Map();
    for (const k of fetched) {
      const d = dayStart(k.openTime);
      if (!split.has(d)) split.set(d, []);
      split.get(d).push(k);
    }
    for (let d = from; d <= to; d += DAY_MS) {
      const candles = split.get(d) || [];
      await writeDay(dir, symbol, interval, d, candles, nowMs);
      byDay.set(d, candles);
    }
  }

  const candles = [...byDay.keys()].sort((a, b) => a - b)
    .flatMap(d => byDay.get(d))
    .filter(k => k.openTime >= startMs && k.openTime <= endMs);
  return { candles, downloadedDays: missing.length, cachedDays: byDay.size - missing.length };
}
