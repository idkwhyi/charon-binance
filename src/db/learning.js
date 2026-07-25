import { query as pgQuery } from './pg-connection.js';
import { now, json } from '../utils.js';

/**
 * Add a new learning lesson
 */
export async function addLesson(lesson) {
  try {
    const result = await pgQuery(
      "INSERT INTO learning_lessons (lesson, status, created_at_ms) VALUES ($1, 'active', $2) RETURNING id",
      [lesson, Date.now()]
    );
    return result.rows[0]?.id || null;
  } catch (err) {
    console.error('[learning] addLesson failed:', err.message);
    return null;
  }
}

/**
 * Get all active lessons
 */
export async function getActiveLessons(limit = 10) {
  try {
    const result = await pgQuery(
      "SELECT id, lesson FROM learning_lessons WHERE status = 'active' ORDER BY id DESC LIMIT $1",
      [limit]
    );
    return result.rows;
  } catch (err) {
    console.error('[learning] getActiveLessons failed:', err.message);
    return [];
  }
}

/**
 * Record the automatic feature+decision+outcome row for a just-closed
 * position. Called from closePosition() so every exit path (TP/SL/manual/
 * MAX_HOLD) is captured without needing to touch other call sites.
 * Never throws — a logging failure must not block a real position close.
 */
export async function recordDecisionOutcome(positionId) {
  try {
    const posResult = await pgQuery('SELECT * FROM positions WHERE id = $1', [positionId]);
    const position = posResult.rows[0];
    if (!position || position.status !== 'closed') return null;

    const candidate = position.candidate_id
      ? (await pgQuery('SELECT * FROM candidates WHERE id = $1', [position.candidate_id])).rows[0] || null
      : null;
    const decision = position.candidate_id
      ? (await pgQuery('SELECT * FROM decisions WHERE candidate_id = $1 ORDER BY id DESC LIMIT 1', [position.candidate_id])).rows[0] || null
      : null;

    const leverage = Number(position.leverage || 1);
    const entryUsdt = Number(position.entry_usdt || 0);
    const slPercent = Number(position.sl_percent || 0);
    const pnlUsdt = Number(position.pnl_usdt || 0);
    const riskUsdt = Math.abs(entryUsdt * leverage * slPercent / 100);
    const rMultiple = riskUsdt > 0 ? pnlUsdt / riskUsdt : null;
    const holdTimeMs = (position.closed_at_ms && position.opened_at_ms)
      ? Number(position.closed_at_ms) - Number(position.opened_at_ms)
      : null;

    await pgQuery(`
      INSERT INTO decision_outcomes (
        position_id, candidate_id, decision_id, symbol, signal_type, direction, strategy_id, execution_mode,
        verdict, confidence, candidate_features_json,
        leverage, entry_price, exit_price, entry_usdt, tp_percent, sl_percent,
        pnl_percent, pnl_usdt, exit_reason, r_multiple, hold_time_ms,
        opened_at_ms, closed_at_ms, created_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
      ON CONFLICT (position_id) DO NOTHING
    `, [
      position.id, position.candidate_id, decision?.id || null,
      position.symbol, candidate?.signal_type || null, position.direction, position.strategy_id, position.execution_mode,
      decision?.verdict || null, decision?.confidence ?? null, json(candidate?.candidate_json || {}),
      leverage, position.entry_price, position.exit_price, entryUsdt, position.tp_percent, slPercent,
      position.pnl_percent, pnlUsdt, position.exit_reason, rMultiple, holdTimeMs,
      position.opened_at_ms, position.closed_at_ms, now(),
    ]);
  } catch (err) {
    console.error('[learning] recordDecisionOutcome failed:', err.message);
  }
  return null;
}

/**
 * Group closed-trade outcomes into 5 confidence buckets (0-20, 20-40, ...)
 * and compare each bucket's actual win rate against its nominal confidence
 * range — answers "is an 80% confidence signal actually winning ~80%?".
 */
export async function confidenceCalibration() {
  try {
    const result = await pgQuery(`
      SELECT
        width_bucket(confidence, 0, 100, 5) AS bucket,
        COUNT(*) AS total,
        SUM(CASE WHEN pnl_usdt > 0 THEN 1 ELSE 0 END) AS wins,
        AVG(pnl_usdt) AS avg_pnl_usdt,
        AVG(r_multiple) AS avg_r_multiple
      FROM decision_outcomes
      WHERE confidence IS NOT NULL
      GROUP BY bucket
      ORDER BY bucket
    `);
    return result.rows.map(r => {
      const total = Number(r.total);
      const wins = Number(r.wins);
      return {
        bucketLow: (Number(r.bucket) - 1) * 20,
        bucketHigh: Number(r.bucket) * 20,
        total,
        wins,
        winRate: total > 0 ? (wins / total) * 100 : 0,
        avgPnlUsdt: Number(r.avg_pnl_usdt || 0),
        avgRMultiple: r.avg_r_multiple !== null ? Number(r.avg_r_multiple) : null,
      };
    });
  } catch (err) {
    console.error('[learning] confidenceCalibration failed:', err.message);
    return [];
  }
}
