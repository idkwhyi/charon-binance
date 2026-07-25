/**
 * Database Migration Script
 * PostgreSQL Schema Setup
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';
const { Pool } = pg;

dotenv.config();

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

  // Step 2: Run schema migrations, in filename order (001_, 002_, ...)
  console.log('📝 Running schema migrations...');
  const migrationFiles = fs.readdirSync(__dirname)
    .filter(f => /^\d+_.*\.sql$/.test(f))
    .sort();

  for (const file of migrationFiles) {
    console.log(`   → ${file}`);
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
    try {
      await pool.query(sql);
    } catch (err) {
      if (err.message.includes('already exists')) {
        console.log(`   ℹ️  ${file}: schema already exists, skipping`);
      } else {
        console.error(`❌ Migration ${file} failed:`, err.message);
        await pool.end();
        process.exit(1);
      }
    }
  }
  console.log('✅ Schema migrations complete\n');

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
