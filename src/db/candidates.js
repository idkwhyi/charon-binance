import { db } from './connection.js';
import { now, json } from '../utils.js';

export function upsertCandidate(candidate) {
  const existing = db.prepare(
    "SELECT id FROM candidates WHERE symbol = ? AND signal_type = ? AND status = 'candidate' AND created_at_ms > ?"
  ).get(candidate.symbol, candidate.signalType, now() - 5 * 60_000);

  if (existing) {
    db.prepare("UPDATE candidates SET candidate_json = ?, filters_json = ? WHERE id = ?")
      .run(json(candidate), json(candidate.filters), existing.id);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO candidates (symbol, signal_type, direction, status, candidate_json, filters_json, created_at_ms)
    VALUES (?, ?, ?, 'candidate', ?, ?, ?)
  `).run(candidate.symbol, candidate.signalType, candidate.direction, json(candidate), json(candidate.filters), now());

  return result.lastInsertRowid;
}

export function updateCandidateStatus(id, status) {
  db.prepare("UPDATE candidates SET status = ? WHERE id = ?").run(status, id);
}

export function candidateById(id) {
  const row = db.prepare("SELECT * FROM candidates WHERE id = ?").get(id);
  if (!row) return null;
  return { ...row, candidate: JSON.parse(row.candidate_json), filters: JSON.parse(row.filters_json || '{}') };
}

export function recentEligibleCandidates(limit = 10) {
  const rows = db.prepare(`
    SELECT * FROM candidates
    WHERE status = 'candidate' AND created_at_ms > ?
    ORDER BY created_at_ms DESC LIMIT ?
  `).all(now() - 10 * 60_000, limit);
  return rows.map(r => ({ ...r, candidate: JSON.parse(r.candidate_json), filters: JSON.parse(r.filters_json || '{}') }));
}
