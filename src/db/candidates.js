import { query as pgQuery } from './pg-connection.js';
import { now, json } from '../utils.js';

export async function upsertCandidate(candidate) {
  try {
    const existing = await pgQuery(
      "SELECT id FROM candidates WHERE symbol = $1 AND signal_type = $2 AND status = 'candidate' AND created_at_ms > $3",
      [candidate.symbol, candidate.signalType, now() - 5 * 60_000]
    );

    if (existing.rows.length > 0) {
      await pgQuery(
        "UPDATE candidates SET candidate_json = $1, filters_json = $2 WHERE id = $3",
        [json(candidate), json(candidate.filters), existing.rows[0].id]
      );
      return existing.rows[0].id;
    }

    const result = await pgQuery(`
      INSERT INTO candidates (symbol, signal_type, direction, status, candidate_json, filters_json, created_at_ms)
      VALUES ($1, $2, $3, 'candidate', $4, $5, $6)
      RETURNING id
    `, [candidate.symbol, candidate.signalType, candidate.direction, json(candidate), json(candidate.filters), now()]);

    return result.rows[0]?.id;
  } catch (err) {
    console.error('[candidates] upsertCandidate failed:', err.message);
    return null;
  }
}

export async function updateCandidateStatus(id, status) {
  try {
    await pgQuery("UPDATE candidates SET status = $1 WHERE id = $2", [status, id]);
  } catch (err) {
    console.error('[candidates] updateCandidateStatus failed:', err.message);
  }
}

export async function candidateById(id) {
  try {
    const result = await pgQuery("SELECT * FROM candidates WHERE id = $1", [id]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return { ...row, candidate: JSON.parse(row.candidate_json), filters: JSON.parse(row.filters_json || '{}') };
  } catch (err) {
    console.error('[candidates] candidateById failed:', err.message);
    return null;
  }
}

export async function recentEligibleCandidates(limit = 10) {
  try {
    const result = await pgQuery(`
      SELECT * FROM candidates
      WHERE status = 'candidate' AND created_at_ms > $1
      ORDER BY created_at_ms DESC LIMIT $2
    `, [now() - 10 * 60_000, limit]);
    return result.rows.map(r => ({ ...r, candidate: JSON.parse(r.candidate_json), filters: JSON.parse(r.filters_json || '{}') }));
  } catch (err) {
    console.error('[candidates] recentEligibleCandidates failed:', err.message);
    return [];
  }
}
