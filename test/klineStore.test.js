import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getKlinesCached, contiguousRuns } from '../src/backtest/klineStore.js';

const DAY = 24 * 60 * 60_000;
const H1 = 60 * 60_000;
const D0 = Date.UTC(2026, 0, 1);
const NOW = D0 + 30 * DAY;
const k = openTime => ({ openTime, open: 1, high: 1, low: 1, close: 1, volume: 1, closeTime: openTime + H1 - 1, quoteVolume: 1 });

function exchange({ holes = [] } = {}) {
  const calls = [];
  const fetchRange = async (symbol, interval, from, to) => {
    calls.push([from, to]);
    const out = [];
    for (let t = Math.ceil(from / H1) * H1; t <= to; t += H1) if (!holes.includes(t)) out.push(k(t));
    return out;
  };
  return { calls, fetchRange };
}

test('contiguousRuns groups consecutive days', () => {
  assert.deepEqual(contiguousRuns([D0, D0 + DAY, D0 + 3 * DAY]), [[D0, D0 + DAY], [D0 + 3 * DAY, D0 + 3 * DAY]]);
  assert.deepEqual(contiguousRuns([]), []);
});

test('first run downloads, second run is served entirely from disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kstore-'));
  const ex = exchange();
  const a = await getKlinesCached('AAA', '1h', D0, D0 + 3 * DAY - 1, { dir, fetchRange: ex.fetchRange, nowMs: NOW });
  assert.equal(a.candles.length, 72);
  assert.equal(a.downloadedDays, 3);
  assert.equal(ex.calls.length, 1, 'contiguous missing days fetched in one range');
  assert.deepEqual(readdirSync(join(dir, 'AAA', '1h')).sort(), ['2026-01-01.json', '2026-01-02.json', '2026-01-03.json']);

  const b = await getKlinesCached('AAA', '1h', D0, D0 + 3 * DAY - 1, { dir, fetchRange: ex.fetchRange, nowMs: NOW });
  assert.equal(ex.calls.length, 1, 'no new download');
  assert.equal(b.downloadedDays, 0);
  assert.deepEqual(b.candles, a.candles);
});

test('only the missing range is downloaded when the window grows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kstore-'));
  const ex = exchange();
  await getKlinesCached('AAA', '1h', D0 + DAY, D0 + 2 * DAY - 1, { dir, fetchRange: ex.fetchRange, nowMs: NOW });
  const r = await getKlinesCached('AAA', '1h', D0, D0 + 4 * DAY - 1, { dir, fetchRange: ex.fetchRange, nowMs: NOW });
  assert.equal(r.candles.length, 96);
  assert.deepEqual(ex.calls.slice(1), [[D0, D0 + DAY - 1], [D0 + 2 * DAY, D0 + 4 * DAY - 1]]);
});

test('a day fetched while in progress is re-downloaded later; a finished day is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kstore-'));
  const ex = exchange();
  const midDay = D0 + 12 * H1 + 5;
  const partial = await getKlinesCached('AAA', '1h', D0, D0 + DAY - 1, { dir, fetchRange: ex.fetchRange, nowMs: midDay });
  assert.equal(partial.candles.length, 13);
  assert.equal(JSON.parse(readFileSync(join(dir, 'AAA', '1h', '2026-01-01.json'), 'utf8')).complete, false);
  const full = await getKlinesCached('AAA', '1h', D0, D0 + DAY - 1, { dir, fetchRange: ex.fetchRange, nowMs: NOW });
  assert.equal(full.candles.length, 24);
  assert.equal(ex.calls.length, 2);
  await getKlinesCached('AAA', '1h', D0, D0 + DAY - 1, { dir, fetchRange: ex.fetchRange, nowMs: NOW + DAY });
  assert.equal(ex.calls.length, 2, 'complete day stays cached');
});

test('an exchange-side hole in a finished day is cached, not re-downloaded forever', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kstore-'));
  const ex = exchange({ holes: [D0 + 5 * H1] });
  const a = await getKlinesCached('AAA', '1h', D0, D0 + DAY - 1, { dir, fetchRange: ex.fetchRange, nowMs: NOW });
  assert.equal(a.candles.length, 23);
  await getKlinesCached('AAA', '1h', D0, D0 + DAY - 1, { dir, fetchRange: ex.fetchRange, nowMs: NOW });
  assert.equal(ex.calls.length, 1);
});

test('symbols and intervals are cached separately; results are clipped to the window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kstore-'));
  const ex = exchange();
  const r = await getKlinesCached('AAA', '1h', D0 + 3 * H1, D0 + 5 * H1, { dir, fetchRange: ex.fetchRange, nowMs: NOW });
  assert.deepEqual(r.candles.map(c => c.openTime), [D0 + 3 * H1, D0 + 4 * H1, D0 + 5 * H1]);
  await getKlinesCached('BBB', '1h', D0, D0 + 1, { dir, fetchRange: ex.fetchRange, nowMs: NOW });
  assert.equal(ex.calls.length, 2, 'BBB not served from AAA files');
});
