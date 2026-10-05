import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMetricsDay, openInterestAt, createOpenInterestSource, earliestMetricsDay } from '../src/backtest/metricsStore.js';
import { dailyMetricsPath } from '../src/backtest/vision.js';
import { filterCandidate } from '../src/pipeline/candidateBuilder.js';
import { runBacktest } from '../src/backtest/runner.js';
import * as runner from '../src/backtest/runner.js';
import { installFakePool } from './helpers/fakePool.js';
import { stubHistory, M1, H1 } from './helpers/history.js';
import { fakeVision } from './helpers/vision.js';

const DAY = 86_400_000, M5 = 5 * M1;
const D = Date.UTC(2026, 0, 10);
const tmp = () => mkdtempSync(join(tmpdir(), 'charon-oi-'));
const fmt = t => new Date(t).toISOString().replace('T', ' ').slice(0, 19);

function metricsCsv(symbol, dayMs, oi, { from = dayMs, to = dayMs + DAY } = {}) {
  const rows = ['create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio'];
  for (let t = from; t < to; t += M5) rows.push(`${fmt(t)},${symbol},${oi},${oi * 100},1`);
  return rows.join('\n');
}

test('openInterestAt: latest row at or before t, stale rows count as missing', () => {
  const rows = [{ t: 0, sumOpenInterest: 1 }, { t: M5, sumOpenInterest: 2 }];
  assert.equal(openInterestAt(rows, M5 - 1).sumOpenInterest, 1, 'never a row after t');
  assert.equal(openInterestAt(rows, M5).sumOpenInterest, 2);
  assert.equal(openInterestAt(rows, M5 + 31 * M1), null, 'older than 30 min');
  assert.equal(openInterestAt([], 0), null);
});

test('getMetricsDay: cached after the first download; a missing day is cached only once published', async () => {
  const dir = tmp();
  const { http, requests } = fakeVision({ [dailyMetricsPath('AAAUSDT', D)]: metricsCsv('AAAUSDT', D, 7) });
  const rows = await getMetricsDay('AAAUSDT', D, { dir, http, nowMs: D + 10 * DAY });
  assert.equal(rows.length, 288);
  await getMetricsDay('AAAUSDT', D, { dir, http, nowMs: D + 10 * DAY });
  assert.equal(requests.length, 1);

  assert.equal(await getMetricsDay('AAAUSDT', D + 9 * DAY, { dir, http, nowMs: D + 10 * DAY }), null);
  assert.ok(!existsSync(join(dir, 'AAAUSDT', '2026-01-19.json')), 'recent: may not be published yet, retried later');
  assert.equal(await getMetricsDay('AAAUSDT', D + DAY, { dir, http, nowMs: D + 10 * DAY }), null);
  assert.ok(existsSync(join(dir, 'AAAUSDT', '2026-01-11.json')), 'old enough: cached as missing');
});

test('OI source: just after midnight the previous day is used; coverage counts lookups', async () => {
  const { http } = fakeVision({ [dailyMetricsPath('AAAUSDT', D)]: metricsCsv('AAAUSDT', D, 7) });
  const src = createOpenInterestSource({ dir: tmp(), http, nowMs: D + 10 * DAY });
  assert.equal((await src.at('AAAUSDT', D + DAY + 10 * M1)).sumOpenInterest, 7);
  assert.equal(await src.at('AAAUSDT', D + DAY + 2 * H1), null);
  const cov = await src.coverage();
  assert.deepEqual([cov.lookups, cov.found, cov.missing], [2, 1, 1]);
});

test('filterCandidate: missing OI rejected or ignored by policy; low OI always rejected', async () => {
  const strat = { min_open_interest_usdt: 10e6, signal_types: 'volume_spike', leverage: 5 };
  const cand = oi => ({ signalType: 'volume_spike', metrics: { markPrice: 100, volume24hUsdt: 1e9, openInterestUsdt: oi } });
  const rej = await filterCandidate(cand(null), strat);
  assert.deepEqual([rej.passed, rej.reasonCode, rej.failures], [false, 'OI_UNAVAILABLE', ['open interest: unavailable (min $10000000)']], "default 'reject', live and backtest");
  assert.equal((await filterCandidate(cand(null), strat, { oiMissing: 'ignore' })).passed, true);
  assert.equal((await filterCandidate(cand(5e6), strat)).reasonCode, 'filter_failed');
  assert.equal((await filterCandidate(cand(null), { ...strat, min_open_interest_usdt: 0 })).passed, true, 'no OI filter: OI not needed');
  assert.equal((await filterCandidate(cand(5e6), strat, { oiMissing: 'ignore' })).passed, false);
  assert.equal((await filterCandidate(cand(20e6), strat, { oiMissing: 'reject' })).passed, true);
});

async function runWithOi(oiMissing) {
  const id = `oi_test_${oiMissing}`;
  // min_open_interest_usdt not set: the strategy default (10M) applies, as in live
  const strat = { signal_types: 'volume_spike', min_volume_spike_ratio: 3, leverage: 5, tp_percent: 2, sl_percent: -1.5, max_hold_ms: 4 * H1, max_open_positions: 5 };
  const opened = [];
  let params = null;
  installFakePool((text, p) => {
    if (/LIKE 'strategy:%'/.test(text)) return [{ key: `strategy:${id}`, value: strat }];
    if (/key = \$1/.test(text) && p[0] === `strategy:${id}`) return [{ value: strat }];
    if (/INSERT INTO backtest_runs/.test(text)) return [{ id: 1 }];
    if (/INSERT INTO backtest_positions/.test(text)) { opened.push(p[1]); return [{ id: opened.length }]; }
    if (/SET params_json/.test(text)) params = JSON.parse(p[0]);
    return [];
  });
  const { http } = fakeVision({
    [dailyMetricsPath('AAA', D)]: metricsCsv('AAA', D, 1e6),  // 1e6 contracts * 100 = 100M USDT
    [dailyMetricsPath('BBB', D)]: metricsCsv('BBB', D, 1000), // 100k USDT < 10M
  });                                                          // CCC: no metrics at all
  const restore = stubHistory({ AAA: [{ spikeAt: D + 30 * M1 }], BBB: [{ spikeAt: D + 90 * M1 }], CCC: [{ spikeAt: D + 150 * M1 }] });
  const log = console.log; console.log = () => {};
  try {
    await runBacktest({ strategyId: id, symbols: ['AAA', 'BBB', 'CCC'], dateFromMs: D, dateToMs: D + 6 * H1, startingBalance: 1000,
      cacheDir: tmp(), oiMissing, openInterestSource: createOpenInterestSource({ dir: tmp(), http, nowMs: D + 10 * DAY }) });
  } finally { console.log = log; restore(); }
  const codes = r => runner.lastRunRejections.filter(x => x.reasonCode === r).map(x => x.symbol);
  return { opened, params, rejected: [...codes('filter_failed'), ...codes('OI_UNAVAILABLE')], unavailable: codes('OI_UNAVAILABLE') };
}

test('fixed universe (--symbols): historical OI filter applies; missing OI rejected by default', async () => {
  const { opened, params, rejected, unavailable } = await runWithOi('reject');
  assert.deepEqual(opened, ['AAA']);
  assert.deepEqual(rejected, ['BBB', 'CCC']);
  assert.deepEqual(unavailable, ['CCC'], 'same reason code as live');
  assert.equal(params.openInterest.minOpenInterestUsdt, 10_000_000);
  assert.deepEqual([params.openInterest.lookups, params.openInterest.found, params.openInterest.rejectedMissing], [3, 2, 1]);
});

test("fixed universe: oiMissing 'ignore' skips the filter only where OI is missing", async () => {
  const { opened, rejected } = await runWithOi('ignore');
  assert.deepEqual(opened, ['AAA', 'CCC']);
  assert.deepEqual(rejected, ['BBB']);
});

test('earliestMetricsDay: first daily metrics file of a symbol (checksums ignored)', async () => {
  const { http, requests } = fakeVision({
    [dailyMetricsPath('BTCUSDT', D)]: '', [dailyMetricsPath('BTCUSDT', D + DAY)]: '',
  }, { extraKeys: [`${dailyMetricsPath('BTCUSDT', D)}.CHECKSUM`] });
  assert.equal(await earliestMetricsDay('BTCUSDT', { http }), '2026-01-10');
  assert.equal(await earliestMetricsDay('NOPEUSDT', { http }), null);
  assert.ok(requests.every(u => u.includes('max-keys=5')));
});
