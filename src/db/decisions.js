import { query as pgQuery } from './pg-connection.js';
import { now, json } from '../utils.js';

export async function storeDecision(candidateId, candidate, decision) {
  try {
    const result = await pgQuery(`
      INSERT INTO decisions (candidate_id, verdict, confidence, direction, reason, risks_json, tp_percent, sl_percent, raw_json, created_at_ms)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10)
      RETURNING id
    `, [
      candidateId,
      decision.verdict,
      decision.confidence,
      decision.direction || null,
      decision.reason,
      json(decision.risks || []),
      decision.suggested_tp_percent,
      decision.suggested_sl_percent,
      json(decision.raw || {}),
      now(),
    ]);
    return result.rows[0]?.id;
  } catch (err) {
    console.error('[decisions] storeDecision failed:', err.message);
    return null;
  }
}

export async function storeBatchDecision(triggerCandidateId, rows, batchDecision) {
  try {
    const result = await pgQuery(`
      INSERT INTO batch_decisions (trigger_id, verdict, selected_id, selected_symbol, direction, confidence, reason, raw_json, created_at_ms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
      RETURNING id
    `, [
      triggerCandidateId,
      batchDecision.verdict,
      batchDecision.selected_candidate_id || null,
      batchDecision.selected_symbol || null,
      batchDecision.direction || null,
      batchDecision.confidence,
      batchDecision.reason,
      json(batchDecision.raw || {}),
      now(),
    ]);
    return result.rows[0]?.id;
  } catch (err) {
    console.error('[decisions] storeBatchDecision failed:', err.message);
    return null;
  }
}

export async function createTradeIntent(candidateId, candidate, decision, mode, status = 'pending') {
  try {
    const result = await pgQuery(`
      INSERT INTO trade_intents (candidate_id, intent_json, status, created_at_ms)
      VALUES ($1,$2::jsonb,$3,$4)
      RETURNING id
    `, [candidateId, json({ candidate, decision, mode }), status, now()]);
    return result.rows[0]?.id;
  } catch (err) {
    console.error('[decisions] createTradeIntent failed:', err.message);
    return null;
  }
}

export async function getTradeIntent(id) {
  try {
    const result = await pgQuery("SELECT * FROM trade_intents WHERE id = $1", [id]);
    return result.rows[0] || null;
  } catch (err) {
    console.error('[decisions] getTradeIntent failed:', err.message);
    return null;
  }
}

export async function updateTradeIntentStatus(id, status) {
  try {
    await pgQuery("UPDATE trade_intents SET status = $1 WHERE id = $2", [status, id]);
  } catch (err) {
    console.error('[decisions] updateTradeIntentStatus failed:', err.message);
  }
}
