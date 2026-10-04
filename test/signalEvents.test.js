import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignalEvent, candleCloseMs, recordSignalEvent } from '../src/db/signalEvents.js';
import { detectExtremeOB, SIGNAL_TYPE_REJECT } from '../src/signals/extremeOB.js';
import { setPool } from '../src/db/pg-connection.js';
import { installFakePool } from './helpers/fakePool.js';

const raw = { symbol: 'BTCUSDT', direction: 'LONG', signalType: 'extreme_ob', klines15m: [{ closeTime: 1 }, { closeTime: 900_000 }] };

test('candle close time comes from raw klines or a built candidate snapshot', () => {
  assert.equal(candleCloseMs(raw), 900_000);
  assert.equal(candleCloseMs({ klineSnapshot: { last5_15m: [{ closeTime: 42 }] } }), 42);
  assert.equal(candleCloseMs({}), null);
});

test('builds a row with outcome, reason and links', () => {
  const row = buildSignalEvent(raw, { stage: 'entry', outcome: 'executed', reasonCode: 'opened', positionId: 9, candidateId: 3 }, 123);
  assert.deepEqual(
    { at: row.at_ms, sym: row.symbol, dir: row.direction, type: row.signal_type, candle: row.candle_close_ms, stage: row.stage, outcome: row.outcome, code: row.reason_code, pos: row.position_id, cand: row.candidate_id },
    { at: 123, sym: 'BTCUSDT', dir: 'LONG', type: 'extreme_ob', candle: 900_000, stage: 'entry', outcome: 'executed', code: 'opened', pos: 9, cand: 3 },
  );
});

test('insert is idempotent per candle (ON CONFLICT DO NOTHING)', async () => {
  const calls = installFakePool();
  await recordSignalEvent(raw, { stage: 'pipeline', outcome: 'rejected', reasonCode: 'dedup' });
  assert.match(calls[0].text, /INSERT INTO signal_events/);
  assert.match(calls[0].text, /ON CONFLICT DO NOTHING/);
  assert.equal(calls[0].params[7], 'dedup');
});

test('a logging failure never throws into the trading path', async () => {
  setPool({ query: async () => { throw new Error('db down'); } });
  const origError = console.error;
  console.error = () => {};
  try {
    await assert.doesNotReject(recordSignalEvent(raw, { stage: 'pipeline', outcome: 'rejected', reasonCode: 'x' }));
  } finally {
    console.error = origError;
  }
});

const mk = (prices, step) => prices.map((p, i) => ({ openTime: i * step, open: p, high: p * 1.002, low: p * 0.998, close: p, volume: 1, closeTime: i * step + step - 1 }));

test('detector emits coded reject signals (ranging market, funding filter)', () => {
  const origLog = console.log;
  console.log = () => {};
  try {
    const ranging = detectExtremeOB(mk(Array(60).fill(100), 3_600_000), mk(Array(30).fill(100), 900_000), 0);
    assert.deepEqual(ranging.map(s => [s.type, s.meta.reasonCode]), [[SIGNAL_TYPE_REJECT, 'ranging_market']]);

    const up = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5 + 4 * Math.sin(i / 2.5));
    const funding = detectExtremeOB(mk(up, 3_600_000), mk(Array(30).fill(up[79]), 900_000), 0.01);
    assert.deepEqual(funding.map(s => [s.type, s.direction, s.meta.reasonCode]), [[SIGNAL_TYPE_REJECT, 'LONG', 'funding_filter']]);
  } finally {
    console.log = origLog;
  }
});
