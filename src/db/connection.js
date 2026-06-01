/**
 * Database Connection Compatibility Layer
 * Proxies to PostgreSQL via pg-connection.js
 * 
 * This module provides SQLite-like synchronous interface for compatibility.
 * All operations are wrapped to work with async PostgreSQL operations.
 */

import { pool, query as pgQuery } from './pg-connection.js';

export let db;

/**
 * Initialize database connection
 * Note: This is now a no-op since PostgreSQL is initialized via initPgDb()
 */
export function initDb() {
  // PostgreSQL initialization is handled in app.js via initPgDb()
  // This function is kept for backward compatibility
  console.log('[db] SQLite initialization skipped - using PostgreSQL');
}

/**
 * Execute a query
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<object>} - Query result
 * @deprecated Use pg-connection.query() for new code
 */
export async function queryDb(text, params = []) {
  return await pgQuery(text, params);
}

/**
 * Export pool for direct access if needed
 */
export { pool };
