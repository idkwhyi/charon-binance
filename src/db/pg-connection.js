/**
 * PostgreSQL Database Connection
 * Database: endelif
 */

import pg from 'pg';
const { Pool } = pg;

export let pool;

/**
 * Initialize PostgreSQL connection pool
 */
export async function initPgDb() {
  const config = {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'endelif',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || '',
    max: parseInt(process.env.PG_POOL_MAX || '20'),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  };

  pool = new Pool(config);

  // Test connection
  try {
    const client = await pool.connect();
    console.log(`[pg] connected to database: ${config.database}`);
    client.release();
  } catch (err) {
    console.error('[pg] connection error:', err.message);
    throw err;
  }

  // Handle pool errors
  pool.on('error', (err) => {
    console.error('[pg] unexpected error on idle client', err);
  });

  return pool;
}

/**
 * Execute a query
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<object>} - Query result
 */
export async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 100) {
      console.log('[pg] slow query:', { text, duration, rows: res.rowCount });
    }
    return res;
  } catch (err) {
    console.error('[pg] query error:', { text, error: err.message });
    throw err;
  }
}

/**
 * Get a client from the pool for transactions
 * @returns {Promise<object>} - PostgreSQL client
 */
export async function getClient() {
  return await pool.connect();
}

/**
 * Close the connection pool
 */
export async function closePgDb() {
  if (pool) {
    await pool.end();
    console.log('[pg] connection pool closed');
  }
}

/**
 * Helper: Convert milliseconds timestamp to PostgreSQL timestamp
 * @param {number} ms - Milliseconds since epoch
 * @returns {Date} - JavaScript Date object
 */
export function msToTimestamp(ms) {
  return new Date(ms);
}

/**
 * Helper: Convert PostgreSQL timestamp to milliseconds
 * @param {Date} timestamp - PostgreSQL timestamp
 * @returns {number} - Milliseconds since epoch
 */
export function timestampToMs(timestamp) {
  return timestamp ? new Date(timestamp).getTime() : null;
}

/**
 * Helper: JSON stringify for PostgreSQL JSONB
 * @param {object} obj - JavaScript object
 * @returns {string} - JSON string
 */
export function toJsonb(obj) {
  return JSON.stringify(obj);
}

/**
 * Helper: Parse JSONB from PostgreSQL
 * @param {string|object} jsonb - JSONB data
 * @returns {object} - JavaScript object
 */
export function fromJsonb(jsonb) {
  if (typeof jsonb === 'string') {
    return JSON.parse(jsonb);
  }
  return jsonb;
}
