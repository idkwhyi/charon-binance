import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';

export let db;

export function initDb() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Candidates: enriched market signals
    CREATE TABLE IF NOT EXISTS candidates (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol        TEXT NOT NULL,
      signal_type   TEXT NOT NULL,
      direction     TEXT NOT NULL CHECK(direction IN ('LONG','SHORT')),
      status        TEXT NOT NULL DEFAULT 'candidate',
      candidate_json TEXT NOT NULL,
      filters_json  TEXT,
      created_at_ms INTEGER NOT NULL
    );

    -- LLM decisions
    CREATE TABLE IF NOT EXISTS decisions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id  INTEGER,
      verdict       TEXT NOT NULL,
      confidence    INTEGER,
      direction     TEXT,
      reason        TEXT,
      risks_json    TEXT,
      tp_percent    REAL,
      sl_percent    REAL,
      raw_json      TEXT,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY(candidate_id) REFERENCES candidates(id)
    );

    -- LLM batch decisions
    CREATE TABLE IF NOT EXISTS batch_decisions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_id      INTEGER,
      verdict         TEXT,
      selected_id     INTEGER,
      selected_symbol TEXT,
      direction       TEXT,
      confidence      INTEGER,
      reason          TEXT,
      raw_json        TEXT,
      created_at_ms   INTEGER NOT NULL
    );

    -- Positions (dry-run and live)
    CREATE TABLE IF NOT EXISTS positions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id      INTEGER,
      symbol            TEXT NOT NULL,
      direction         TEXT NOT NULL CHECK(direction IN ('LONG','SHORT')),
      leverage          INTEGER NOT NULL DEFAULT 1,
      margin_type       TEXT NOT NULL DEFAULT 'ISOLATED',
      entry_price       REAL,
      entry_usdt        REAL,
      notional_usdt     REAL,
      tp_percent        REAL,
      sl_percent        REAL,
      trailing_enabled  INTEGER DEFAULT 0,
      trailing_percent  REAL DEFAULT 0,
      trailing_armed    INTEGER DEFAULT 0,
      high_water_price  REAL,
      low_water_price   REAL,
      liq_price         REAL,
      status            TEXT NOT NULL DEFAULT 'open',
      execution_mode    TEXT NOT NULL DEFAULT 'dry_run',
      binance_order_id  TEXT,
      opened_at_ms      INTEGER NOT NULL,
      closed_at_ms      INTEGER,
      exit_price        REAL,
      exit_reason       TEXT,
      pnl_percent       REAL,
      pnl_usdt          REAL,
      strategy_id       TEXT,
      partial_tp_done   INTEGER DEFAULT 0,
      FOREIGN KEY(candidate_id) REFERENCES candidates(id)
    );

    -- Trade log
    CREATE TABLE IF NOT EXISTS trades (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id   INTEGER NOT NULL,
      symbol        TEXT NOT NULL,
      direction     TEXT NOT NULL,
      side          TEXT NOT NULL,
      at_ms         INTEGER NOT NULL,
      price         REAL,
      pnl_percent   REAL,
      pnl_usdt      REAL,
      reason        TEXT,
      payload_json  TEXT,
      FOREIGN KEY(position_id) REFERENCES positions(id)
    );

    -- Trade intents (confirm mode)
    CREATE TABLE IF NOT EXISTS trade_intents (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id  INTEGER,
      intent_json   TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY(candidate_id) REFERENCES candidates(id)
    );

    -- Strategy config (hot-read)
    CREATE TABLE IF NOT EXISTS strategy_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Learning lessons
    CREATE TABLE IF NOT EXISTS learning_lessons (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      lesson  TEXT NOT NULL,
      status  TEXT NOT NULL DEFAULT 'active',
      created_at_ms INTEGER NOT NULL
    );
  `);

  // Seed default strategy if empty
  const existing = db.prepare("SELECT value FROM strategy_config WHERE key = 'active_strategy'").get();
  if (!existing) {
    db.prepare("INSERT INTO strategy_config (key, value) VALUES ('active_strategy', 'scalp')").run();
    seedDefaultStrategies();
  }

  // Always ensure newer strategies are present and up-to-date
  upsertMissingStrategies();

  console.log('[db] initialized');
}

function seedDefaultStrategies() {
  const strategies = [
    {
      id: 'scalp',
      label: 'Scalp',
      use_llm: true,
      leverage: 5,
      tp_percent: 2,
      sl_percent: -1.5,
      trailing_enabled: false,
      trailing_percent: 0,
      max_hold_ms: 4 * 60 * 60 * 1000,
      min_volume_spike_ratio: 3,
      min_open_interest_usdt: 10_000_000,
      max_open_positions: 3,
      llm_min_confidence: 70,
      signal_types: 'volume_spike,ema_cross_bull,ema_cross_bear',
    },
    {
      id: 'swing',
      label: 'Swing',
      use_llm: true,
      leverage: 3,
      tp_percent: 6,
      sl_percent: -3,
      trailing_enabled: true,
      trailing_percent: 2,
      max_hold_ms: 24 * 60 * 60 * 1000,
      min_volume_spike_ratio: 2,
      min_open_interest_usdt: 20_000_000,
      max_open_positions: 2,
      llm_min_confidence: 75,
      signal_types: 'rsi_oversold,rsi_overbought,volume_spike',
    },
    {
      id: 'funding_fade',
      label: 'Funding Fade',
      use_llm: true,
      leverage: 2,
      tp_percent: 4,
      sl_percent: -2,
      trailing_enabled: false,
      trailing_percent: 0,
      max_hold_ms: 8 * 60 * 60 * 1000,
      min_volume_spike_ratio: 1,
      min_open_interest_usdt: 50_000_000,
      max_open_positions: 2,
      llm_min_confidence: 75,
      signal_types: 'funding_extreme',
    },
    {
      id: 'degen',
      label: 'Degen',
      use_llm: false,
      leverage: 10,
      tp_percent: 5,
      sl_percent: -3,
      trailing_enabled: false,
      trailing_percent: 0,
      max_hold_ms: 2 * 60 * 60 * 1000,
      min_volume_spike_ratio: 5,
      min_open_interest_usdt: 5_000_000,
      max_open_positions: 1,
      llm_min_confidence: 0,
      signal_types: 'volume_spike',
    },
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
  const insert = db.prepare("INSERT OR IGNORE INTO strategy_config (key, value) VALUES (?, ?)");
  for (const s of strategies) {
    insert.run(`strategy:${s.id}`, JSON.stringify(s));
  }
}

/**
 * Ensure strategies added after initial seed are present in the DB.
 * Safe to call on every startup — uses INSERT OR IGNORE.
 */
function upsertMissingStrategies() {
  const missing = [
    {
      id: 'extreme_ob',
      label: 'Extreme Order Block',
      use_llm: true,
      leverage: 5,
      tp_percent: 4,
      sl_percent: -2,
      trailing_enabled: false,
      trailing_percent: 0,
      max_hold_ms: 8 * 60 * 60 * 1000,
      min_volume_spike_ratio: 1,
      min_open_interest_usdt: 5_000_000,
      min_volume_24h_usdt: 50_000_000,
      max_open_positions: 5,
      llm_min_confidence: 60,
      signal_types: 'extreme_ob',
    },
  ];
  // Use INSERT OR REPLACE to always keep strategy config up-to-date
  const upsert = db.prepare("INSERT OR REPLACE INTO strategy_config (key, value) VALUES (?, ?)");
  for (const s of missing) {
    upsert.run(`strategy:${s.id}`, JSON.stringify(s));
  }
}
