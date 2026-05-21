/**
 * Database Migration Script
 * Migrates from SQLite to PostgreSQL
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
const { Pool } = pg;
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// PostgreSQL configuration
const pgConfig = {
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE || 'endelif',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || '120404',
};

// SQLite database path
const sqlitePath = process.env.DB_PATH || './charon-binance.sqlite';

/**
 * Safely parse JSON data for PostgreSQL JSONB conversion
 * @param {any} value - Value to parse as JSON
 * @returns {string} - Valid JSON string or null
 */
function safeJsonParse(value) {
  // Handle null or undefined
  if (value === null || value === undefined) {
    return null;
  }
  
  // Handle empty string
  if (value === '') {
    return null;
  }
  
  // If it's already an object, stringify it
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (err) {
      console.warn('Failed to stringify object:', err.message);
      return null;
    }
  }
  
  // If it's a string, try to parse and re-stringify to validate
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(parsed);
    } catch (err) {
      // If parsing fails, treat as plain string and wrap in quotes
      try {
        return JSON.stringify(value);
      } catch (stringifyErr) {
        console.warn('Failed to handle string value:', stringifyErr.message);
        return null;
      }
    }
  }
  
  // For other types (number, boolean), stringify them
  try {
    return JSON.stringify(value);
  } catch (err) {
    console.warn('Failed to stringify value:', err.message);
    return null;
  }
}

async function runMigration() {
  console.log('🚀 Starting database migration...\n');

  // Step 1: Connect to PostgreSQL
  console.log('📡 Connecting to PostgreSQL...');
  const pool = new Pool(pgConfig);
  
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ PostgreSQL connected\n');
  } catch (err) {
    console.error('❌ PostgreSQL connection failed:', err.message);
    process.exit(1);
  }

  // Step 2: Run schema migration
  console.log('📝 Running schema migration...');
  const schemaPath = path.join(__dirname, '001_initial_schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  
  try {
    await pool.query(schemaSql);
    console.log('✅ Schema created successfully\n');
  } catch (err) {
    if (err.message.includes('already exists')) {
      console.log('ℹ️  Schema already exists, skipping schema creation\n');
    } else {
      console.error('❌ Schema migration failed:', err.message);
      await pool.end();
      process.exit(1);
    }
  }

  // Step 3: Migrate data from SQLite (if exists)
  if (fs.existsSync(sqlitePath)) {
    console.log('📦 Migrating data from SQLite...');
    const sqlite = new Database(sqlitePath, { readonly: true });

    try {
      // Migrate candidates
      const candidates = sqlite.prepare('SELECT * FROM candidates').all();
      console.log(`  Migrating ${candidates.length} candidates...`);
      for (const row of candidates) {
        // Safely handle JSONB fields
        const candidateJson = safeJsonParse(row.candidate_json);
        const filtersJson = safeJsonParse(row.filters_json);
        
        await pool.query(
          `INSERT INTO candidates (id, symbol, signal_type, direction, status, candidate_json, filters_json, created_at_ms)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
           ON CONFLICT (id) DO NOTHING`,
          [row.id, row.symbol, row.signal_type, row.direction, row.status, candidateJson, filtersJson, row.created_at_ms]
        );
      }
      console.log('  ✅ Candidates migrated');

      // Migrate decisions
      const decisions = sqlite.prepare('SELECT * FROM decisions').all();
      console.log(`  Migrating ${decisions.length} decisions...`);
      for (const row of decisions) {
        // Safely handle JSONB fields
        const risksJson = safeJsonParse(row.risks_json);
        const rawJson = safeJsonParse(row.raw_json);
        
        await pool.query(
          `INSERT INTO decisions (id, candidate_id, verdict, confidence, direction, reason, risks_json, tp_percent, sl_percent, raw_json, created_at_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11)
           ON CONFLICT (id) DO NOTHING`,
          [row.id, row.candidate_id, row.verdict, row.confidence, row.direction, row.reason, risksJson, row.tp_percent, row.sl_percent, rawJson, row.created_at_ms]
        );
      }
      console.log('  ✅ Decisions migrated');

      // Migrate positions
      const positions = sqlite.prepare('SELECT * FROM positions').all();
      console.log(`  Migrating ${positions.length} positions...`);
      for (const row of positions) {
        await pool.query(
          `INSERT INTO positions (id, candidate_id, symbol, direction, leverage, margin_type, entry_price, entry_usdt, notional_usdt,
                                  tp_percent, sl_percent, trailing_enabled, trailing_percent, trailing_armed, high_water_price, low_water_price,
                                  liq_price, status, execution_mode, binance_order_id, opened_at_ms, closed_at_ms, exit_price, exit_reason,
                                  pnl_percent, pnl_usdt, strategy_id, partial_tp_done)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
           ON CONFLICT (id) DO NOTHING`,
          [row.id, row.candidate_id, row.symbol, row.direction, row.leverage, row.margin_type, row.entry_price, row.entry_usdt, row.notional_usdt,
           row.tp_percent, row.sl_percent, row.trailing_enabled === 1, row.trailing_percent, row.trailing_armed === 1, row.high_water_price, row.low_water_price,
           row.liq_price, row.status, row.execution_mode, row.binance_order_id, row.opened_at_ms, row.closed_at_ms, row.exit_price, row.exit_reason,
           row.pnl_percent, row.pnl_usdt, row.strategy_id, row.partial_tp_done === 1]
        );
      }
      console.log('  ✅ Positions migrated');

      // Migrate trades
      const trades = sqlite.prepare('SELECT * FROM trades').all();
      console.log(`  Migrating ${trades.length} trades...`);
      for (const row of trades) {
        // Safely handle JSONB fields
        const payloadJson = safeJsonParse(row.payload_json);
        
        await pool.query(
          `INSERT INTO trades (id, position_id, symbol, direction, side, at_ms, price, pnl_percent, pnl_usdt, reason, payload_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [row.id, row.position_id, row.symbol, row.direction, row.side, row.at_ms, row.price, row.pnl_percent, row.pnl_usdt, row.reason, payloadJson]
        );
      }
      console.log('  ✅ Trades migrated');

      // Migrate strategy_config
      const configs = sqlite.prepare('SELECT * FROM strategy_config').all();
      console.log(`  Migrating ${configs.length} strategy configs...`);
      for (const row of configs) {
        // Safely handle JSONB field
        const value = safeJsonParse(row.value);
        
        await pool.query(
          `INSERT INTO strategy_config (key, value)
           VALUES ($1, $2::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [row.key, value]
        );
      }
      console.log('  ✅ Strategy configs migrated');

      // Update sequences
      console.log('  Updating sequences...');
      const tables = ['candidates', 'decisions', 'batch_decisions', 'positions', 'trades', 'trade_intents', 'learning_lessons', 'watchlist', 'watch_alerts'];
      for (const table of tables) {
        try {
          await pool.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`);
        } catch (err) {
          // Ignore if table is empty
        }
      }
      console.log('  ✅ Sequences updated');

      sqlite.close();
      console.log('✅ Data migration completed\n');
    } catch (err) {
      console.error('❌ Data migration failed:', err.message);
      sqlite.close();
      await pool.end();
      process.exit(1);
    }
  } else {
    console.log('ℹ️  No SQLite database found, skipping data migration\n');
  }

  // Step 4: Seed default strategies
  console.log('🌱 Seeding default strategies...');
  const strategies = [
    {
      id: 'extreme_ob',
      label: 'Extreme Order Block',
      use_llm: false,
      leverage: 5,
      tp_percent: 3,
      sl_percent: -1.5,
      trailing_enabled: false,
      trailing_percent: 0,
      max_hold_ms: 8 * 60 * 60 * 1000,
      min_volume_spike_ratio: 1,
      min_open_interest_usdt: 20_000_000,
      min_volume_24h_usdt: 50_000_000,
      max_open_positions: 2,
      llm_min_confidence: 0,
      signal_types: 'extreme_ob',
    },
  ];

  for (const s of strategies) {
    await pool.query(
      `INSERT INTO strategy_config (key, value)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`strategy:${s.id}`, JSON.stringify(s)]
    );
  }

  await pool.query(
    `INSERT INTO strategy_config (key, value)
     VALUES ('active_strategy', $1::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify('extreme_ob')]
  );

  console.log('✅ Default strategies seeded\n');

  // Close connection
  await pool.end();
  console.log('🎉 Migration completed successfully!');
  console.log('\n📝 Next steps:');
  console.log('1. Update .env file with PostgreSQL credentials:');
  console.log('   USE_POSTGRES=true');
  console.log('   PG_HOST=localhost');
  console.log('   PG_PORT=5432');
  console.log('   PG_DATABASE=endelif');
  console.log('   PG_USER=postgres');
  console.log('   PG_PASSWORD=your_password');
  console.log('2. Restart the bot: npm start');
}

// Run migration
runMigration().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
