import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hybridFetchRange, prepareDynamicUniverse } from '../src/backtest/dynamicUniverse.js';
import { VISION_DATA_URL, VISION_LIST_URL, UM_DAILY_KLINES } from '../src/backtest/vision.js';
import { runBacktest } from '../src/backtest/runner.js';
import { installFakePool } from './helpers/fakePool.js';
import { makeZip, klineCsv } from './helpers/vision.js';
import { ampleOpenInterest } from './helpers/history.js';
import axios from 'axios';

// No test here may reach the network
const realGet = axios.get;
axios.get = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
process.on('exit', () => { axios.get = realGet; });

const M1 = 60_000, M15 = 15 * M1, H1 = 60 * M1, DAY = 24 * H1;
const STEP = { '1m': M1, '15m': M15, '1h': H1, '1d': DAY };
const T0 = Date.UTC(2026, 2, 10);
const NOW = T0 + 30 * DAY;
const tmp = () => mkdtempSync(join(tmpdir(), 'charon-dyn-'));
const iso = ms => new Date(ms).toISOString().slice(0, 10);

/**
 * Generated archive: spec = { SYM: { from, to, price(openTime), spikeAt? } } (days inclusive).
 * Serves listings and daily kline zips for any interval; monthly files 404 (daily fallback).
 */
function generatedArchive(spec) {
  const requests = [];
  const keys = [];
  for (const [sym, s] of Object.entries(spec)) for (let d = s.from; d <= s.to; d += DAY) keys.push(`${UM_DAILY_KLINES}${sym}/1d/${sym}-1d-${iso(d)}.zip`);
  keys.sort();
  const http = async (url) => {
    requests.push(url);
    if (url.startsWith(VISION_LIST_URL)) {
      const q = new URL(url).searchParams;
      const prefix = q.get('prefix'), marker = q.get('marker') || '';
      const matching = keys.filter(k => k.startsWith(prefix) && k > marker);
      const body = q.get('delimiter')
        ? [...new Set(matching.map(k => prefix + k.slice(prefix.length).split('/')[0] + '/'))].map(p => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join('')
        : matching.map(k => `<Contents><Key>${k}</Key></Contents>`).join('');
      return { status: 200, data: Buffer.from(`<ListBucketResult><IsTruncated>false</IsTruncated>${body}</ListBucketResult>`) };
    }
    const m = url.slice(VISION_DATA_URL.length + 1).match(/^data\/futures\/um\/daily\/klines\/([A-Z0-9]+)\/(\w+)\/[A-Z0-9]+-\w+-(\d{4}-\d{2}-\d{2})\.zip$/);
    const s = m && spec[m[1]];
    const d = m && Date.parse(`${m[3]}T00:00:00Z`);
    if (!s || d < s.from || d > s.to) return { status: 404, data: Buffer.alloc(0) };
    const step = STEP[m[2]];
    const candles = [];
    for (let o = d; o < d + DAY; o += step) {
      const prev = s.price(o - step), c = s.price(o);
      const spike = m[2] === '15m' && o === s.spikeAt;
      candles.push({ openTime: o, open: spike ? c - 0.1 : prev, high: Math.max(prev, c) + 0.05, low: Math.min(prev, c) - 0.05, close: c,
        volume: spike ? 1000 : 1, closeTime: o + step - 1, quoteVolume: 1e6 * step / M15 });
    }
    return { status: 200, data: makeZip('x.csv', klineCsv(candles)) };
  };
  return { http, requests };
}

const requested = (requests, sym, iv) => requests.filter(u => u.includes(`/klines/${sym}/${iv}/`)).map(u => u.match(/(\d{4}-\d{2}-\d{2})\.zip$/)[1]);

test('hybridFetchRange: archive only for a delisted symbol, clipped to its trading range', async () => {
  const { http, requests } = generatedArchive({ DEADUSDT: { from: T0, to: T0 + DAY, price: () => 100 } });
  const rest = [];
  const fetch = hybridFetchRange({ symbol: 'DEADUSDT', firstDayMs: T0, lastDayMs: T0 + DAY, listed: false }, {
    http, nowMs: NOW, restFetchRange: async (...a) => { rest.push(a); return []; } });
  const ks = await fetch('DEADUSDT', '1h', T0 - 5 * DAY, T0 + 9 * DAY);
  assert.equal(ks.length, 48);
  assert.deepEqual(requested(requests, 'DEADUSDT', '1h'), [iso(T0), iso(T0 + DAY)]);
  assert.equal(rest.length, 0);
});

test('hybridFetchRange: listed symbol uses REST for days newer than the archive lag and for archive holes', async () => {
  const now = T0 + 5 * DAY + 3 * H1;
  const { http } = generatedArchive({ LIVEUSDT: { from: T0, to: T0 + DAY, price: () => 100 } }); // archive misses T0+2d
  const rest = [];
  const fetch = hybridFetchRange({ symbol: 'LIVEUSDT', firstDayMs: T0, lastDayMs: T0 + 5 * DAY, listed: true }, {
    http, nowMs: now, restFetchRange: async (sym, iv, a, b) => { rest.push([iso(a), iso(b)]); return []; } });
  await fetch('LIVEUSDT', '1h', T0, now);
  assert.deepEqual(rest, [[iso(T0 + 2 * DAY), iso(T0 + 2 * DAY)], [iso(T0 + 3 * DAY), iso(T0 + 5 * DAY)]]);
});

test('dynamic universe end to end: 15m for every symbol, full data only for members, delisted symbols included', async () => {
  const flat = () => 100;
  const jumpAt = T0 + 2 * H1;
  const spec = {
    COREUSDT: { from: T0 - 10 * DAY, to: T0 + 5 * DAY, price: flat },
    MOVERUSDT: { from: T0 - 10 * DAY, to: T0 + 5 * DAY, price: o => (o >= jumpAt ? 110 : 100), spikeAt: T0 + 3 * H1 },
    QUIETUSDT: { from: T0 - 10 * DAY, to: T0 + 5 * DAY, price: flat },
    GONEUSDT: { from: T0 - 10 * DAY, to: T0 + 2 * DAY, price: o => (o >= jumpAt ? 90 : 100) }, // delisted, not in exchangeInfo
  };
  const { http, requests } = generatedArchive(spec);
  const cacheDir = tmp();
  const info = ['COREUSDT', 'MOVERUSDT', 'QUIETUSDT'].map(symbol => ({ symbol, status: 'TRADING', contractType: 'PERPETUAL', underlyingType: 'COIN' }));
  const rest = [];
  const { timeline, fetchRangeFor } = await prepareDynamicUniverse({
    dateFromMs: T0, dateToMs: T0 + DAY, core: ['COREUSDT'], exchangeInfoSymbols: info, unknownUnderlying: 'coin',
    cacheDir, registryFile: join(tmp(), 'symbols.json'), http, nowMs: NOW, log: () => {},
    restFetchRange: async (...a) => { rest.push(a); return []; },
  });
  assert.deepEqual(timeline.symbols().sort(), ['COREUSDT', 'GONEUSDT', 'MOVERUSDT']);
  assert.deepEqual(timeline.intervals.get('MOVERUSDT'), [[jumpAt + M15, null]]);
  assert.deepEqual(timeline.delisted, ['GONEUSDT']);
  for (const s of Object.keys(spec)) assert.ok(requested(requests, s, '15m').length >= 2, `15m cached for ${s}`);
  assert.equal(rest.length, 0, 'everything older than the archive lag comes from the archive');

  // Run: full data only for members, from their entry minus warmup
  const id = 'dyn_test';
  const strat = { signal_types: 'volume_spike', min_volume_spike_ratio: 3, leverage: 5, tp_percent: 2, sl_percent: -1.5, max_hold_ms: 4 * H1, max_open_positions: 5 };
  const opened = [];
  installFakePool((text, p) => {
    if (/LIKE 'strategy:%'/.test(text)) return [{ key: `strategy:${id}`, value: strat }];
    if (/key = \$1/.test(text) && p[0] === `strategy:${id}`) return [{ value: strat }];
    if (/INSERT INTO backtest_runs/.test(text)) return [{ id: 1 }];
    if (/INSERT INTO backtest_positions/.test(text)) { opened.push([p[1], p[11]]); return [{ id: opened.length }]; }
    return [];
  });
  const before = requests.length;
  const log = console.log; console.log = () => {};
  try {
    await runBacktest({ strategyId: id, universe: timeline, fetchRangeFor, dateFromMs: T0, dateToMs: T0 + DAY, startingBalance: 1000,
      cacheDir, openInterestSource: ampleOpenInterest(), fetchFunding: async () => [] });
  } finally { console.log = log; }
  const during = requests.slice(before);
  assert.deepEqual(opened, [['MOVERUSDT', T0 + 3 * H1 + M15]], 'dynamic symbol traded after it joined');
  assert.equal(requested(during, 'QUIETUSDT', '1h').length, 0, 'never in the universe: no 1h');
  assert.equal(requested(during, 'QUIETUSDT', '1m').length, 0, 'never in the universe: no 1m');
  const mover1h = requested(during, 'MOVERUSDT', '1h');
  assert.equal(mover1h[0], iso(jumpAt + M15 - 100 * H1), '1h from entry minus a full live window (100 candles)');
  assert.deepEqual(requested(during, 'MOVERUSDT', '1m'), [iso(T0)], '1m only for the day a position was open');
  assert.equal(requested(during, 'COREUSDT', '1m').length, 0);
});
