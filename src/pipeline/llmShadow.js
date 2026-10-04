import { query as pgQuery } from '../db/pg-connection.js';
import { now, json } from '../utils.js';
import { LLM_MODEL } from '../config.js';
import { decideCandidateBatch } from './llm.js';

/**
 * Does the LLM's shadow pick match the rule-based pick?
 * A non-buy verdict "agrees" only if the selector picked nothing either.
 */
export function shadowAgrees(ruleCandidateId, llmDecision) {
  const llmId = llmDecision?.selected_candidate_id ?? null;
  return (ruleCandidateId ?? null) === llmId;
}

/** LLM errors/unavailability are reported via risks by decideCandidateBatch. */
export function shadowError(llmDecision) {
  const risks = llmDecision?.risks || [];
  if (risks.includes('llm_error') || risks.includes('no_llm_decision')) return llmDecision.reason || 'llm unavailable';
  return null;
}

/**
 * Ask the LLM (temperature 0, JSON) to pick among this cycle's candidates and
 * record its answer next to the rule-based pick. Never throws and never
 * affects execution.
 * @param {Array<{candidate: object, candidateId: number}>} prepared
 * @param {{candidate: object, candidateId: number}|null} rulePick
 */
export async function recordLlmShadow(prepared, rulePick) {
  const started = now();
  try {
    const rows = prepared.map(p => ({ id: p.candidateId, candidate: p.candidate }));
    const decision = await decideCandidateBatch(rows, rulePick?.candidateId ?? rows[0]?.id, { temperature: 0, jsonMode: true });
    const error = shadowError(decision);
    await pgQuery(`
      INSERT INTO llm_shadow_decisions (
        at_ms, model, candidate_ids, rule_candidate_id, rule_symbol,
        llm_verdict, llm_candidate_id, llm_symbol, llm_direction, llm_confidence, llm_reason,
        agrees, error, latency_ms, raw_json
      ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
    `, [
      started, LLM_MODEL, json(rows.map(r => r.id)), rulePick?.candidateId ?? null, rulePick?.candidate.symbol ?? null,
      decision.verdict, decision.selected_candidate_id ?? null, decision.selected_symbol ?? null,
      decision.direction ?? null, Math.round(Number(decision.confidence) || 0), decision.reason ?? null,
      error ? null : shadowAgrees(rulePick?.candidateId, decision), error, now() - started,
      decision.raw ? json(decision.raw) : null,
    ]);
  } catch (err) {
    console.log(`[llm_shadow] ignored error: ${err.message}`);
  }
}
