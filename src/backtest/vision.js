/**
 * Minimal client for the public Binance archive at data.binance.vision
 * (USDⓈ-M futures): bucket listings, zip download + unzip, CSV parsing.
 * The archive also covers delisted symbols, which the REST API no longer serves.
 *
 * Layout used here:
 *   data/futures/um/daily/klines/<SYM>/<iv>/<SYM>-<iv>-YYYY-MM-DD.zip
 *   data/futures/um/monthly/klines/<SYM>/<iv>/<SYM>-<iv>-YYYY-MM.zip
 *   data/futures/um/daily/metrics/<SYM>/<SYM>-metrics-YYYY-MM-DD.zip   (5-minute open interest)
 *
 * Every network call goes through an injectable `http(url) -> { status, data: Buffer }`
 * so tests never touch the network.
 */

import axios from 'axios';
import zlib from 'node:zlib';
import { sleep } from '../utils.js';

export const VISION_DATA_URL = 'https://data.binance.vision';
export const VISION_LIST_URL = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision';
export const UM_DAILY_KLINES = 'data/futures/um/daily/klines/';
export const UM_MONTHLY_KLINES = 'data/futures/um/monthly/klines/';
export const UM_DAILY_METRICS = 'data/futures/um/daily/metrics/';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const dayStart = ms => Math.floor(ms / DAY_MS) * DAY_MS;
export const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
export const isoMonth = ms => new Date(ms).toISOString().slice(0, 7);

/** GET with retries on network errors / 5xx; 403 and 404 come back as status (missing object). */
export async function defaultHttp(url, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer', timeout: 30_000,
        validateStatus: s => s === 200 || s === 403 || s === 404,
      });
      return { status: res.status, data: Buffer.from(res.data) };
    } catch (err) {
      if (attempt >= retries) throw new Error(`GET ${url} failed: ${err.message}`);
      await sleep(1000 * 2 ** attempt);
    }
  }
}

/** Parse one S3 ListObjects (v1) XML page. */
export function parseS3Listing(xml) {
  const text = String(xml);
  const all = (tag) => [...text.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map(m => m[1]);
  const prefixes = [...text.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>/g)].map(m => m[1]);
  return {
    keys: all('Key'),
    prefixes,
    isTruncated: /<IsTruncated>true<\/IsTruncated>/.test(text),
    nextMarker: all('NextMarker')[0] || null,
  };
}

/**
 * Every key and common prefix under `prefix` (all pages), or only the first
 * `maxKeys` after `marker`.
 * @param {string} prefix
 * @param {{ http?: Function, delimiter?: boolean, marker?: string, maxKeys?: number }} [opts]
 */
export async function listS3(prefix, { http = defaultHttp, delimiter = true, marker = '', maxKeys = null } = {}) {
  const keys = [], prefixes = [];
  let cursor = marker;
  for (;;) {
    const qs = new URLSearchParams({ prefix, ...(delimiter ? { delimiter: '/' } : {}), ...(cursor ? { marker: cursor } : {}),
      ...(maxKeys ? { 'max-keys': String(maxKeys) } : {}) });
    const res = await http(`${VISION_LIST_URL}?${qs}`);
    if (res.status !== 200) throw new Error(`listing ${prefix} failed with HTTP ${res.status}`);
    const page = parseS3Listing(res.data.toString('utf8'));
    keys.push(...page.keys);
    prefixes.push(...page.prefixes);
    if (!page.isTruncated || (maxKeys && keys.length + prefixes.length >= maxKeys)) break;
    const next = page.nextMarker || [...page.keys, ...page.prefixes].sort().at(-1);
    if (!next || next === cursor) break;
    cursor = next;
  }
  return { keys, prefixes };
}

/** Contents of the first file in a zip archive (the archive's zips hold one CSV each). */
export function unzipFirstEntry(buf) {
  const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const cen = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cen) !== CEN) throw new Error('corrupt zip central directory');
  const method = buf.readUInt16LE(cen + 10);
  const compressedSize = buf.readUInt32LE(cen + 20);
  const local = buf.readUInt32LE(cen + 42);
  if (buf.readUInt32LE(local) !== LOC) throw new Error('corrupt zip local header');
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const body = buf.subarray(start, start + compressedSize);
  if (method === 0) return Buffer.from(body);
  if (method === 8) return zlib.inflateRawSync(body);
  throw new Error(`unsupported zip compression method ${method}`);
}

/** Download a zip from the archive and return its CSV text, or null if the file does not exist. */
export async function fetchZipCsv(path, { http = defaultHttp } = {}) {
  const res = await http(`${VISION_DATA_URL}/${path}`);
  if (res.status !== 200) return null;
  return unzipFirstEntry(res.data).toString('utf8');
}

const toMs = v => {
  const n = Number(v);
  return n > 1e14 ? Math.floor(n / 1000) : n; // tolerate microsecond timestamps
};

/** Kline CSV (with or without header) -> candles in the REST shape. */
export function parseKlineCsv(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line || !/^\d/.test(line)) continue; // header / blank
    const c = line.split(',');
    out.push({
      openTime: toMs(c[0]), open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]),
      volume: Number(c[5]), closeTime: toMs(c[6]), quoteVolume: Number(c[7]),
    });
  }
  return out.sort((a, b) => a.openTime - b.openTime);
}

/**
 * Metrics CSV -> [{ t, sumOpenInterest, sumOpenInterestValue }].
 * Columns: create_time,symbol,sum_open_interest,sum_open_interest_value,...
 * create_time is 'YYYY-MM-DD HH:MM:SS' UTC (or epoch ms).
 */
export function parseMetricsCsv(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line || !/^\d/.test(line)) continue;
    const c = line.split(',');
    const t = /^\d+$/.test(c[0]) ? toMs(c[0]) : Date.parse(`${c[0].replace(' ', 'T')}Z`);
    const oi = Number(c[2]), oiValue = Number(c[3]);
    if (!Number.isFinite(t) || !Number.isFinite(oi)) continue;
    out.push({ t, sumOpenInterest: oi, sumOpenInterestValue: Number.isFinite(oiValue) ? oiValue : null });
  }
  return out.sort((a, b) => a.t - b.t);
}

export const dailyKlinePath = (symbol, interval, dayMs) =>
  `${UM_DAILY_KLINES}${symbol}/${interval}/${symbol}-${interval}-${isoDay(dayMs)}.zip`;
export const monthlyKlinePath = (symbol, interval, monthMs) =>
  `${UM_MONTHLY_KLINES}${symbol}/${interval}/${symbol}-${interval}-${isoMonth(monthMs)}.zip`;
export const dailyMetricsPath = (symbol, dayMs) =>
  `${UM_DAILY_METRICS}${symbol}/${symbol}-metrics-${isoDay(dayMs)}.zip`;

const monthStart = ms => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const nextMonth = ms => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

/**
 * Archive klines with openTime in [startMs, endMs]: monthly files for whole
 * months inside the range, daily files elsewhere (or when a monthly file is
 * missing). Only closed candles (closeTime < nowMs) are returned.
 * Same signature as fetchKlinesRange, so it plugs into getKlinesCached.
 */
export async function fetchKlinesRangeVision(symbol, interval, startMs, endMs, { http = defaultHttp, nowMs = Date.now() } = {}) {
  const parts = [];
  let d = dayStart(startMs);
  const lastDay = dayStart(endMs);
  while (d <= lastDay) {
    const m0 = monthStart(d), m1 = nextMonth(d);
    if (d === m0 && m1 - DAY_MS <= lastDay) {
      const csv = await fetchZipCsv(monthlyKlinePath(symbol, interval, m0), { http });
      if (csv !== null) { parts.push(parseKlineCsv(csv)); d = m1; continue; }
    }
    const csv = await fetchZipCsv(dailyKlinePath(symbol, interval, d), { http });
    if (csv !== null) parts.push(parseKlineCsv(csv));
    d += DAY_MS;
  }
  return parts.flat()
    .filter(k => k.openTime >= startMs && k.openTime <= endMs && k.closeTime < nowMs)
    .sort((a, b) => a.openTime - b.openTime);
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
