import { query as pgQuery } from './pg-connection.js';

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
