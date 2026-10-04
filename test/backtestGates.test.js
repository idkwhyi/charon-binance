import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { runBacktest } from '../src/backtest/runner.js';
import * as runner from '../src/backtest/runner.js';
import { portfolioBlock, pickCycleEntry } from '../src/pipeline/portfolioGates.js';
import { MAX_SAME_DIRECTION_POSITIONS } from '../src/config.js';
import { installFakePool } from './helpers/fakePool.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const M1 = 60_000, M15 = 15 * M1, H1 = 60 * M1;
const k = (openTime, step, o = {}) => ({ openTime, open: 100, high: 100.05, low: 99.95, close: 100, volume: 1, quoteVolume: 1e6, closeTime: openTime + step - 1, ...o });

// ── portfolioGates (pure) ─────────────────────────────────────────────────────

test('portfolioBlock order: paused, daily loss, max positions', () => {
  assert.equal(portfolioBlock({ paused: true, daily: { breached: true, pnlPercent: -4 } }).code, 'entries_paused');
  assert.equal(portfolioBlock({ daily: { breached: true, pnlPercent: -3.1 }, dailyLimitPercent: 3, openCount: 9, maxOpenPositions: 2 }).code, 'daily_loss_limit');
  assert.equal(portfolioBlock({ daily: { breached: false, pnlPercent: 0 }, openCount: 2, maxOpenPositions: 2 }).code, 'max_positions');
  assert.equal(portfolioBlock({ openCount: 1, maxOpenPositions: 2 }), null);
});

test('pickCycleEntry: one pick, reasons for the rest', () => {
  const c = (symbol, direction, score) => ({ symbol, direction, metrics: {}, signals: { meta: { entryConfirmation: { score } } } });
  const { selected, rejections } = pickCycleEntry(
    [c('AAA', 'LONG', 6), c('BBB', 'LONG', 9), c('CCC', 'SHORT', 9), c('DDD', 'SHORT', 3)],
    [{ symbol: 'CCC', direction: 'SHORT' }, { symbol: 'XXX', direction: 'LONG' }, { symbol: 'YYY', direction: 'LONG' }],
    2,
  );
  assert.equal(selected.symbol, 'DDD', 'LONG capped, CCC already open');
  assert.deepEqual(rejections.map(r => [r.candidate.symbol, r.reasonCode]),
    [['AAA', 'direction_cap'], ['BBB', 'direction_cap'], ['CCC', 'symbol_open']]);
});

// ── Backtest replays the same gates ───────────────────────────────────────────

const D = Date.UTC(2026, 0, 10);

/** plan: { SYMBOL: [{ spikeAt, stopOut }] } — 15m volume spike at spikeAt; optional SL wick 5m after entry */
function stubHistory(plan) {
  const original = axios.get;
  axios.get = async (url, { params = {} } = {}) => {
    if (url.includes('fundingRate')) return { data: [] };
    const step = { '1m': M1, '15m': M15, '1h': H1 }[params.interval];
    const events = plan[params.symbol] || [];
    const rows = [];
    for (let o = Math.ceil(params.startTime / step) * step; o <= params.endTime && rows.length < params.limit; o += step) {
      let c = k(o, step);
      for (const e of events) {
        if (params.interval === '15m' && o === e.spikeAt) c = k(o, step, { open: 99.9, volume: 1000 });
        const entryT = e.spikeAt + M15;
        if (params.interval === '1m' && e.stopOut && o === entryT + 5 * M1) c = k(o, step, { open: 99.5, high: 99.6, low: 98, close: 98.2 });
      }
      rows.push([c.openTime, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume), c.closeTime, String(c.quoteVolume)]);
    }
    return { data: rows };
  };
  return () => { axios.get = original; };
}

let runSeq = 0;
async function run(plan, { hours = 8, strat: stratOver = {} } = {}) {
  const id = `gate_test_${++runSeq}`; // unique id: strategyById caches for 60s
  const strat = { signal_types: 'volume_spike', min_volume_spike_ratio: 3, leverage: 5, tp_percent: 2, sl_percent: -1.5,
    max_hold_ms: 4 * H1, max_open_positions: 5, ...stratOver };
  const opened = [];
  installFakePool((text, params) => {
    if (/LIKE 'strategy:%'/.test(text)) return [{ key: `strategy:${id}`, value: strat }];
    if (/key = \$1/.test(text) && params[0] === `strategy:${id}`) return [{ value: strat }];
    if (/INSERT INTO backtest_runs/.test(text)) return [{ id: 1 }];
    if (/INSERT INTO backtest_positions/.test(text)) { opened.push({ symbol: params[1], openedAt: params[11] }); return [{ id: opened.length }]; }
    return [];
  });
  const restore = stubHistory(plan);
  const log = console.log; console.log = () => {};
  try {
    await runBacktest({ strategyId: id, symbols: Object.keys(plan), dateFromMs: D, dateToMs: D + hours * H1, startingBalance: 1000,
      cacheDir: mkdtempSync(join(tmpdir(), 'charon-bt-')) });
  } finally { console.log = log; restore(); }
  return { opened, rejected: runner.lastRunRejections.filter(r => r.outcome === 'rejected' && r.stage !== 'detector') };
}

test('at most one entry per cycle, picked by the shared selector', async () => {
  const { opened, rejected } = await run({ BBB: [{ spikeAt: D + 30 * M1 }], AAA: [{ spikeAt: D + 30 * M1 }] });
  assert.deepEqual(opened.map(o => o.symbol), ['AAA'], 'tie on score/R:R/volume → symbol order');
  assert.deepEqual(rejected.map(r => [r.symbol, r.reasonCode]), [['BBB', 'not_selected']]);
});

test(`max ${MAX_SAME_DIRECTION_POSITIONS} open positions in the same direction`, async () => {
  const syms = ['AAA', 'BBB', 'CCC', 'DDD'].slice(0, MAX_SAME_DIRECTION_POSITIONS + 1);
  const plan = Object.fromEntries(syms.map((s, i) => [s, [{ spikeAt: D + (30 + 15 * i) * M1 }]]));
  const { opened, rejected } = await run(plan);
  assert.deepEqual(opened.map(o => o.symbol), syms.slice(0, -1));
  assert.deepEqual(rejected.map(r => [r.symbol, r.reasonCode]), [[syms.at(-1), 'direction_cap']]);
});

test('max open positions per strategy', async () => {
  const { opened, rejected } = await run({ AAA: [{ spikeAt: D + 30 * M1 }], BBB: [{ spikeAt: D + 45 * M1 }] }, { strat: { max_open_positions: 1 } });
  assert.deepEqual(opened.map(o => o.symbol), ['AAA']);
  assert.deepEqual(rejected.map(r => [r.symbol, r.reasonCode]), [['BBB', 'max_positions']]);
});

test('daily loss limit stops entries until 00:00 UTC, then resumes', async () => {
  const losers = ['L1', 'L2', 'L3', 'L4', 'L5'].map((s, i) => [s, [{ spikeAt: D + (1 + 2 * i) * H1, stopOut: true }]]);
  const plan = Object.fromEntries([...losers, ['NEXTDAY', [{ spikeAt: D + 24 * H1 + H1 }]]]);
  const { opened, rejected } = await run(plan, { hours: 27 });
  const limit = rejected.find(r => r.reasonCode === 'daily_loss_limit');
  assert.ok(limit, 'daily loss limit blocked a same-day entry');
  const blockedSymbols = rejected.filter(r => r.reasonCode === 'daily_loss_limit').map(r => r.symbol);
  assert.ok(!opened.some(o => blockedSymbols.includes(o.symbol)), 'blocked symbols never opened');
  assert.ok(opened.length >= 2 && opened.length <= 4, `losses before the limit: ${opened.length - 1}`);
  const next = opened.find(o => o.symbol === 'NEXTDAY');
  assert.ok(next, 'entries resume on the next UTC day');
  assert.ok(next.openedAt >= D + 24 * H1);
});
