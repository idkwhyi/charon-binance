/**
 * Database Migration Script
 * PostgreSQL Schema Setup
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// PostgreSQL configuration
const pgConfig = {
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE || 'endelif',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || '',
};



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

  // Step 3: Seed default strategies
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
