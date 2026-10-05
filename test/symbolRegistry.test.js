import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseS3Listing, listS3, unzipFirstEntry, parseKlineCsv, parseMetricsCsv, fetchKlinesRangeVision, UM_DAILY_KLINES } from '../src/backtest/vision.js';
import { buildSymbolRegistry, tradedBetween, isPerpetualName, formatRegistry } from '../src/backtest/symbolRegistry.js';
import { fakeVision, makeZip, klineCsv } from './helpers/vision.js';

const DAY = 86_400_000;
const D0 = Date.UTC(2024, 0, 30);
const day = ms => new Date(ms).toISOString().slice(0, 10);
const k1d = (sym, d) => `${UM_DAILY_KLINES}${sym}/1d/${sym}-1d-${day(d)}.zip`;

test('unzip + kline CSV: header optional, numbers parsed, sorted', () => {
  const candles = [{ openTime: 900, open: 2, high: 3, low: 1, close: 2.5, volume: 10, closeTime: 1799, quoteVolume: 25 },
    { openTime: 0, open: 1, high: 2, low: 0.5, close: 2, volume: 5, closeTime: 899, quoteVolume: 8 }];
  for (const header of [true, false]) {
    const csv = unzipFirstEntry(makeZip('x.csv', klineCsv(candles, { header }))).toString();
    assert.deepEqual(parseKlineCsv(csv).map(k => k.openTime), [0, 900]);
    assert.deepEqual(parseKlineCsv(csv)[1], candles[0]);
  }
});

test('metrics CSV: create_time as UTC string, open interest columns', () => {
  const csv = 'create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio\n2024-01-01 00:05:00,BTCUSDT,100.5,4200000.25,1.1\n';
  assert.deepEqual(parseMetricsCsv(csv), [{ t: Date.UTC(2024, 0, 1, 0, 5), sumOpenInterest: 100.5, sumOpenInterestValue: 4200000.25 }]);
});

test('S3 listing: prefixes, keys and pagination via NextMarker/marker', async () => {
  const files = Object.fromEntries(['AAAUSDT', 'BBBUSDT', 'CCCUSDT'].map(s => [k1d(s, D0), '']));
  const { http, requests } = fakeVision(files, { pageSize: 2 });
  const { prefixes } = await listS3(UM_DAILY_KLINES, { http });
  assert.deepEqual(prefixes, ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'].map(s => `${UM_DAILY_KLINES}${s}/`));
  assert.equal(requests.length, 2, 'two pages');
  assert.equal(parseS3Listing('<IsTruncated>false</IsTruncated><Contents><Key>a/b.zip</Key></Contents>').keys[0], 'a/b.zip');
});

test('registry: every perpetual incl. delisted, trading range from the archive, exchangeInfo merged', async () => {
  const files = {};
  for (let d = D0; d <= D0 + 4 * DAY; d += DAY) files[k1d('LIVEUSDT', d)] = '';
  for (let d = D0 + DAY; d <= D0 + 2 * DAY; d += DAY) files[k1d('DEADUSDT', d)] = '';
  files[k1d('BTCUSDT_240329', D0)] = ''; // delivery contract: not a perpetual
  const extraKeys = [`${k1d('LIVEUSDT', D0)}.CHECKSUM`];
  const { http } = fakeVision(files, { pageSize: 3, extraKeys });
  const file = join(mkdtempSync(join(tmpdir(), 'charon-reg-')), 'symbols.json');
  const nowMs = D0 + 10 * DAY;
  const reg = await buildSymbolRegistry({
    http, file, nowMs,
    exchangeInfoSymbols: [
      { symbol: 'LIVEUSDT', status: 'TRADING', contractType: 'PERPETUAL', underlyingType: 'COIN', onboardDate: D0 },
      { symbol: 'NEWUSDT', status: 'TRADING', contractType: 'PERPETUAL', underlyingType: 'COIN', onboardDate: D0 + 9 * DAY },
      { symbol: 'BTCUSDT_240329', status: 'TRADING', contractType: 'CURRENT_QUARTER', underlyingType: 'COIN' },
    ],
  });
  assert.deepEqual([...reg.keys()], ['DEADUSDT', 'LIVEUSDT', 'NEWUSDT']);
  const dead = reg.get('DEADUSDT');
  assert.deepEqual([dead.firstDayMs, dead.lastDayMs, dead.delisted, dead.underlyingType], [D0 + DAY, D0 + 2 * DAY, true, null]);
  const live = reg.get('LIVEUSDT');
  assert.deepEqual([live.firstDayMs, live.lastDayMs, live.listed, live.underlyingType], [D0, D0 + 10 * DAY, true, 'COIN']);
  assert.equal(reg.get('NEWUSDT').firstDayMs, D0 + 9 * DAY, 'not archived yet: range from onboardDate');
  assert.ok(tradedBetween(dead, D0 + 2 * DAY + 5, D0 + 9 * DAY));
  assert.ok(!tradedBetween(dead, D0 + 3 * DAY, D0 + 9 * DAY));
  assert.ok(formatRegistry(reg).includes('DEADUSDT'));
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).symbols.DEADUSDT);
  assert.ok(!isPerpetualName('BTCUSDT_240329'));
});

test('registry cache: a delisted symbol with an old last day is final and not listed again', async () => {
  const files = { [k1d('DEADUSDT', D0)]: '' };
  const file = join(mkdtempSync(join(tmpdir(), 'charon-reg-')), 'symbols.json');
  const first = fakeVision(files);
  await buildSymbolRegistry({ http: first.http, file, nowMs: D0 + 30 * DAY });
  const second = fakeVision(files);
  const reg = await buildSymbolRegistry({ http: second.http, file, nowMs: D0 + 31 * DAY });
  assert.equal(second.requests.length, 1, 'only the top-level listing');
  assert.equal(reg.get('DEADUSDT').lastDayMs, D0);
});

test('fetchKlinesRangeVision: monthly file for whole months, daily files otherwise, missing days skipped', async () => {
  const M15 = 900_000;
  const mk = (from, n) => Array.from({ length: n }, (_, i) => ({ openTime: from + i * M15, open: 1, high: 1, low: 1, close: 1, volume: 1, closeTime: from + (i + 1) * M15 - 1, quoteVolume: 1 }));
  const feb = Date.UTC(2024, 1, 1), mar = Date.UTC(2024, 2, 1);
  const files = {
    [`data/futures/um/daily/klines/XUSDT/15m/XUSDT-15m-2024-01-31.zip`]: klineCsv(mk(feb - DAY, 96)),
    [`data/futures/um/monthly/klines/XUSDT/15m/XUSDT-15m-2024-02.zip`]: klineCsv(mk(feb, 29 * 96)),
    [`data/futures/um/daily/klines/XUSDT/15m/XUSDT-15m-2024-03-01.zip`]: klineCsv(mk(mar, 96)),
  };
  const { http, requests } = fakeVision(files);
  const ks = await fetchKlinesRangeVision('XUSDT', '15m', feb - DAY, mar + 2 * DAY - 1, { http, nowMs: mar + 10 * DAY });
  assert.equal(ks.length, 96 + 29 * 96 + 96);
  assert.equal(requests.filter(u => u.includes('/monthly/')).length, 1);
  assert.equal(requests.filter(u => u.includes('/daily/')).length, 3, '01-31, 03-01 and the missing 03-02');
});

test('npm run universe:symbols is wired', () => {
  assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).scripts['universe:symbols'], 'node universe_symbols.js');
});

test('registry range from monthly listing + two small daily listings (no full daily listing)', async () => {
  const files = {};
  for (const m of ['2024-01', '2024-02', '2024-03']) files[`data/futures/um/monthly/klines/OLDUSDT/1d/OLDUSDT-1d-${m}.zip`] = '';
  for (let d = Date.UTC(2024, 0, 15); d <= Date.UTC(2024, 3, 10); d += DAY) files[k1d('OLDUSDT', d)] = '';
  const { http, requests } = fakeVision(files, { pageSize: 1000 });
  const reg = await buildSymbolRegistry({ http, file: join(mkdtempSync(join(tmpdir(), 'charon-reg-')), 's.json'), nowMs: Date.UTC(2024, 5, 1) });
  const e = reg.get('OLDUSDT');
  assert.deepEqual([day(e.firstDayMs), day(e.lastDayMs), e.delisted], ['2024-01-15', '2024-04-10', true]);
  const daily = requests.filter(u => u.includes(encodeURIComponent('daily/klines/OLDUSDT/1d/')));
  assert.equal(daily.length, 2);
  assert.ok(daily.every(u => u.includes('marker=')), 'never a full listing of every daily file');
  assert.ok(daily.some(u => u.includes('max-keys=2')));
});
