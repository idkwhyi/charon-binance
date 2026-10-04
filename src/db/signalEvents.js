import { query as pgQuery } from './pg-connection.js';
import { now, json } from '../utils.js';

/**
 * Close time of the latest 15m candle a signal/candidate was computed on.
 * Raw signals carry klines15m; built candidates carry klineSnapshot.last5_15m.
 */
export function candleCloseMs(src) {
  const klines = src?.klines15m || src?.klineSnapshot?.last5_15m || [];
  return klines[klines.length - 1]?.closeTime ?? null;
}

/**
 * Build a signal_events row from a raw signal or candidate.
 * @param {object} src - raw signal ({ symbol, direction, signalType, klines15m }) or candidate
 * @param {object} e - { stage, outcome, reasonCode, reason?, candidateId?, positionId?, details? }
 */
export function buildSignalEvent(src, e, nowMs = now()) {
  return {
    at_ms: nowMs,
    symbol: src.symbol,
    direction: e.direction ?? src.direction ?? null,
    signal_type: e.signalType ?? src.signalType ?? null,
    candle_close_ms: candleCloseMs(src),
    stage: e.stage,
    outcome: e.outcome,
    reason_code: e.reasonCode,
    reason: e.reason ?? null,
    candidate_id: e.candidateId ?? null,
    position_id: e.positionId ?? null,
    details: e.details ?? null,
  };
}

/**
 * Record what happened to a signal. Never throws — logging must not break trading.
 * Repeats within the same 15m candle are dropped by the unique index.
 */
export async function recordSignalEvent(src, e) {
  const row = buildSignalEvent(src, e);
  try {
    await pgQuery(`
      INSERT INTO signal_events (
        at_ms, symbol, direction, signal_type, candle_close_ms, stage, outcome,
        reason_code, reason, candidate_id, position_id, details_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
      ON CONFLICT DO NOTHING
    `, [row.at_ms, row.symbol, row.direction, row.signal_type, row.candle_close_ms, row.stage, row.outcome,
        row.reason_code, row.reason, row.candidate_id, row.position_id, row.details ? json(row.details) : null]);
  } catch (err) {
    console.error(`[signal_events] record failed (${row.symbol} ${row.reason_code}): ${err.message}`);
  }
}
