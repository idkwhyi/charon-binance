import { db } from './connection.js';
import { now, json } from '../utils.js';

export function storeDecision(candidateId, candidate, decision) {
  const result = db.prepare(`
    INSERT INTO decisions (candidate_id, verdict, confidence, direction, reason, risks_json, tp_percent, sl_percent, raw_json, created_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
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
  );
  return result.lastInsertRowid;
}

export function storeBatchDecision(triggerCandidateId, rows, batchDecision) {
  const result = db.prepare(`
    INSERT INTO batch_decisions (trigger_id, verdict, selected_id, selected_symbol, direction, confidence, reason, raw_json, created_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    triggerCandidateId,
    batchDecision.verdict,
    batchDecision.selected_candidate_id || null,
    batchDecision.selected_symbol || null,
    batchDecision.direction || null,
    batchDecision.confidence,
    batchDecision.reason,
    json(batchDecision.raw || {}),
    now(),
  );
  return result.lastInsertRowid;
}

export function createTradeIntent(candidateId, candidate, decision, mode, status = 'pending') {
  const result = db.prepare(`
    INSERT INTO trade_intents (candidate_id, intent_json, status, created_at_ms)
    VALUES (?,?,?,?)
  `).run(candidateId, json({ candidate, decision, mode }), status, now());
  return result.lastInsertRowid;
}

export function getTradeIntent(id) {
  return db.prepare("SELECT * FROM trade_intents WHERE id = ?").get(id);
}

export function updateTradeIntentStatus(id, status) {
  db.prepare("UPDATE trade_intents SET status = ? WHERE id = ?").run(status, id);
}
