-- PostgreSQL Migration: Backtest Engine Schema
-- Version: 2.3.0
-- Date: 2026-07-25
--
-- Backtest data is kept isolated from the live/dry_run tables (positions,
-- virtual_balance) which hold a single global rolling state. Each backtest
-- run gets its own scoped rows so historical replays never mix with
-- forward paper-trading or live data.

-- ============================================================================
-- TABLE: backtest_runs
-- One row per historical backtest execution
-- ============================================================================
CREATE TABLE IF NOT EXISTS backtest_runs (
    id SERIAL PRIMARY KEY,
    label VARCHAR(200),
    strategy_id VARCHAR(50) NOT NULL,
    symbols_json JSONB NOT NULL,
    date_from_ms BIGINT NOT NULL,
    date_to_ms BIGINT NOT NULL,
    starting_balance DECIMAL(20, 8) NOT NULL DEFAULT 1000.00,
    fee_percent DECIMAL(10, 6) NOT NULL DEFAULT 0.04,
    slippage_percent DECIMAL(10, 6) NOT NULL DEFAULT 0.02,
    params_json JSONB,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    error TEXT,
    started_at_ms BIGINT,
    finished_at_ms BIGINT,
    created_at_ms BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_status ON backtest_runs(status);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_created_at_ms ON backtest_runs(created_at_ms);

-- ============================================================================
-- TABLE: backtest_positions
-- Simulated positions opened/closed while replaying a backtest run
-- ============================================================================
CREATE TABLE IF NOT EXISTS backtest_positions (
    id SERIAL PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
    symbol VARCHAR(20) NOT NULL,
    signal_type VARCHAR(50) NOT NULL,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
    leverage INTEGER NOT NULL DEFAULT 1,
    entry_price DECIMAL(20, 8) NOT NULL,
    entry_usdt DECIMAL(20, 8) NOT NULL,
    tp_percent DECIMAL(10, 4),
    sl_percent DECIMAL(10, 4),
    fee_usdt DECIMAL(20, 8) NOT NULL DEFAULT 0,
    slippage_usdt DECIMAL(20, 8) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    opened_at_ms BIGINT NOT NULL,
    closed_at_ms BIGINT,
    exit_price DECIMAL(20, 8),
    exit_reason TEXT,
    pnl_percent DECIMAL(10, 4),
    pnl_usdt DECIMAL(20, 8),
    candidate_snapshot_json JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_backtest_positions_run_id ON backtest_positions(run_id);
CREATE INDEX IF NOT EXISTS idx_backtest_positions_symbol ON backtest_positions(symbol);
CREATE INDEX IF NOT EXISTS idx_backtest_positions_status ON backtest_positions(status);
CREATE INDEX IF NOT EXISTS idx_backtest_positions_run_status ON backtest_positions(run_id, status);

-- ============================================================================
-- TABLE: backtest_balance
-- Running equity/stats for a run, one row per run_id, updated as replay progresses
-- ============================================================================
CREATE TABLE IF NOT EXISTS backtest_balance (
    run_id INTEGER PRIMARY KEY REFERENCES backtest_runs(id) ON DELETE CASCADE,
    balance_usdt DECIMAL(20, 8) NOT NULL,
    available_balance DECIMAL(20, 8) NOT NULL,
    margin_used DECIMAL(20, 8) NOT NULL DEFAULT 0,
    total_trades INTEGER NOT NULL DEFAULT 0,
    winning_trades INTEGER NOT NULL DEFAULT 0,
    losing_trades INTEGER NOT NULL DEFAULT 0,
    max_drawdown_percent DECIMAL(10, 4) NOT NULL DEFAULT 0,
    peak_balance DECIMAL(20, 8) NOT NULL,
    equity_curve_json JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE backtest_runs IS 'Metadata and config for a single historical backtest execution';
COMMENT ON TABLE backtest_positions IS 'Simulated trades opened/closed during a backtest replay';
COMMENT ON TABLE backtest_balance IS 'Running equity curve and stats per backtest run';
COMMENT ON COLUMN backtest_positions.candidate_snapshot_json IS 'Full candidate object at signal time, for later training-data extraction';
COMMENT ON COLUMN backtest_balance.equity_curve_json IS 'Array of {t, balance} snapshots for charting';
