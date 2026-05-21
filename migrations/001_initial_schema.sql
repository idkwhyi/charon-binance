-- PostgreSQL Migration: Initial Schema
-- Database: endelif
-- Version: 1.0.0
-- Date: 2026-05-20

-- Enable UUID extension for better ID generation (optional)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- TABLE: candidates
-- Enriched market signals
-- ============================================================================
CREATE TABLE IF NOT EXISTS candidates (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    signal_type VARCHAR(50) NOT NULL,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
    status VARCHAR(20) NOT NULL DEFAULT 'candidate',
    candidate_json JSONB NOT NULL,
    filters_json JSONB,
    created_at_ms BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for candidates
CREATE INDEX IF NOT EXISTS idx_candidates_symbol ON candidates(symbol);
CREATE INDEX IF NOT EXISTS idx_candidates_signal_type ON candidates(signal_type);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
CREATE INDEX IF NOT EXISTS idx_candidates_created_at_ms ON candidates(created_at_ms);
CREATE INDEX IF NOT EXISTS idx_candidates_symbol_signal_status ON candidates(symbol, signal_type, status);

-- ============================================================================
-- TABLE: decisions
-- LLM decisions for candidates
-- ============================================================================
CREATE TABLE IF NOT EXISTS decisions (
    id SERIAL PRIMARY KEY,
    candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
    verdict VARCHAR(50) NOT NULL,
    confidence INTEGER,
    direction VARCHAR(10),
    reason TEXT,
    risks_json JSONB,
    tp_percent DECIMAL(10, 4),
    sl_percent DECIMAL(10, 4),
    raw_json JSONB,
    created_at_ms BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for decisions
CREATE INDEX IF NOT EXISTS idx_decisions_candidate_id ON decisions(candidate_id);
CREATE INDEX IF NOT EXISTS idx_decisions_verdict ON decisions(verdict);
CREATE INDEX IF NOT EXISTS idx_decisions_created_at_ms ON decisions(created_at_ms);

-- ============================================================================
-- TABLE: batch_decisions
-- LLM batch decisions (multiple candidates evaluated together)
-- ============================================================================
CREATE TABLE IF NOT EXISTS batch_decisions (
    id SERIAL PRIMARY KEY,
    trigger_id INTEGER,
    verdict VARCHAR(50),
    selected_id INTEGER,
    selected_symbol VARCHAR(20),
    direction VARCHAR(10),
    confidence INTEGER,
    reason TEXT,
    raw_json JSONB,
    created_at_ms BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for batch_decisions
CREATE INDEX IF NOT EXISTS idx_batch_decisions_trigger_id ON batch_decisions(trigger_id);
CREATE INDEX IF NOT EXISTS idx_batch_decisions_selected_id ON batch_decisions(selected_id);
CREATE INDEX IF NOT EXISTS idx_batch_decisions_created_at_ms ON batch_decisions(created_at_ms);

-- ============================================================================
-- TABLE: positions
-- Trading positions (dry-run and live)
-- ============================================================================
CREATE TABLE IF NOT EXISTS positions (
    id SERIAL PRIMARY KEY,
    candidate_id INTEGER REFERENCES candidates(id) ON DELETE SET NULL,
    symbol VARCHAR(20) NOT NULL,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
    leverage INTEGER NOT NULL DEFAULT 1,
    margin_type VARCHAR(20) NOT NULL DEFAULT 'ISOLATED',
    entry_price DECIMAL(20, 8),
    entry_usdt DECIMAL(20, 8),
    notional_usdt DECIMAL(20, 8),
    tp_percent DECIMAL(10, 4),
    sl_percent DECIMAL(10, 4),
    trailing_enabled BOOLEAN DEFAULT FALSE,
    trailing_percent DECIMAL(10, 4) DEFAULT 0,
    trailing_armed BOOLEAN DEFAULT FALSE,
    high_water_price DECIMAL(20, 8),
    low_water_price DECIMAL(20, 8),
    liq_price DECIMAL(20, 8),
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    execution_mode VARCHAR(20) NOT NULL DEFAULT 'dry_run',
    binance_order_id VARCHAR(100),
    opened_at_ms BIGINT NOT NULL,
    closed_at_ms BIGINT,
    exit_price DECIMAL(20, 8),
    exit_reason TEXT,
    pnl_percent DECIMAL(10, 4),
    pnl_usdt DECIMAL(20, 8),
    strategy_id VARCHAR(50),
    partial_tp_done BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for positions
CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_execution_mode ON positions(execution_mode);
CREATE INDEX IF NOT EXISTS idx_positions_strategy_id ON positions(strategy_id);
CREATE INDEX IF NOT EXISTS idx_positions_opened_at_ms ON positions(opened_at_ms);
CREATE INDEX IF NOT EXISTS idx_positions_closed_at_ms ON positions(closed_at_ms);
CREATE INDEX IF NOT EXISTS idx_positions_status_opened ON positions(status, opened_at_ms);

-- ============================================================================
-- TABLE: trades
-- Trade execution log
-- ============================================================================
CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY,
    position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
    symbol VARCHAR(20) NOT NULL,
    direction VARCHAR(10) NOT NULL,
    side VARCHAR(10) NOT NULL,
    at_ms BIGINT NOT NULL,
    price DECIMAL(20, 8),
    pnl_percent DECIMAL(10, 4),
    pnl_usdt DECIMAL(20, 8),
    reason TEXT,
    payload_json JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for trades
CREATE INDEX IF NOT EXISTS idx_trades_position_id ON trades(position_id);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_at_ms ON trades(at_ms);

-- ============================================================================
-- TABLE: trade_intents
-- Trade intents for confirm mode
-- ============================================================================
CREATE TABLE IF NOT EXISTS trade_intents (
    id SERIAL PRIMARY KEY,
    candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
    intent_json JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at_ms BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for trade_intents
CREATE INDEX IF NOT EXISTS idx_trade_intents_candidate_id ON trade_intents(candidate_id);
CREATE INDEX IF NOT EXISTS idx_trade_intents_status ON trade_intents(status);
CREATE INDEX IF NOT EXISTS idx_trade_intents_created_at_ms ON trade_intents(created_at_ms);

-- ============================================================================
-- TABLE: strategy_config
-- Strategy configuration (hot-read)
-- ============================================================================
CREATE TABLE IF NOT EXISTS strategy_config (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- TABLE: virtual_balance
-- Virtual balance tracking for dry_run mode backtesting
-- ============================================================================
CREATE TABLE IF NOT EXISTS virtual_balance (
    id SERIAL PRIMARY KEY,
    balance_usdt DECIMAL(20, 8) NOT NULL DEFAULT 1000.00,
    available_balance DECIMAL(20, 8) NOT NULL DEFAULT 1000.00,
    margin_used DECIMAL(20, 8) NOT NULL DEFAULT 0.00,
    unrealized_pnl DECIMAL(20, 8) NOT NULL DEFAULT 0.00,
    total_realized_pnl DECIMAL(20, 8) NOT NULL DEFAULT 0.00,
    total_trades INTEGER NOT NULL DEFAULT 0,
    winning_trades INTEGER NOT NULL DEFAULT 0,
    losing_trades INTEGER NOT NULL DEFAULT 0,
    max_drawdown_percent DECIMAL(10, 4) NOT NULL DEFAULT 0.00,
    peak_balance DECIMAL(20, 8) NOT NULL DEFAULT 1000.00,
    execution_mode VARCHAR(20) NOT NULL DEFAULT 'dry_run',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default virtual balance for dry_run mode
INSERT INTO virtual_balance (balance_usdt, available_balance, execution_mode) 
VALUES (1000.00, 1000.00, 'dry_run') 
ON CONFLICT DO NOTHING;

-- ============================================================================
-- TABLE: learning_lessons
-- Learning lessons from trades
-- ============================================================================
CREATE TABLE IF NOT EXISTS learning_lessons (
    id SERIAL PRIMARY KEY,
    lesson TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at_ms BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for learning_lessons
CREATE INDEX IF NOT EXISTS idx_learning_lessons_status ON learning_lessons(status);
CREATE INDEX IF NOT EXISTS idx_learning_lessons_created_at_ms ON learning_lessons(created_at_ms);

-- ============================================================================
-- TABLE: watchlist
-- Symbol watchlist
-- ============================================================================
CREATE TABLE IF NOT EXISTS watchlist (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL UNIQUE,
    enabled BOOLEAN DEFAULT TRUE,
    added_at_ms BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for watchlist
CREATE INDEX IF NOT EXISTS idx_watchlist_enabled ON watchlist(enabled);
CREATE INDEX IF NOT EXISTS idx_watchlist_symbol ON watchlist(symbol);

-- ============================================================================
-- TABLE: watch_alerts
-- Track watch alerts to prevent duplicates
-- ============================================================================
CREATE TABLE IF NOT EXISTS watch_alerts (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    direction VARCHAR(10) NOT NULL,
    signal_type VARCHAR(50) NOT NULL,
    ob_high DECIMAL(20, 8),
    ob_low DECIMAL(20, 8),
    last_sent_at_ms BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(symbol, direction, signal_type)
);

-- Indexes for watch_alerts
CREATE INDEX IF NOT EXISTS idx_watch_alerts_symbol ON watch_alerts(symbol);
CREATE INDEX IF NOT EXISTS idx_watch_alerts_last_sent_at_ms ON watch_alerts(last_sent_at_ms);
CREATE INDEX IF NOT EXISTS idx_watch_alerts_symbol_direction ON watch_alerts(symbol, direction);

-- ============================================================================
-- FUNCTIONS: Update timestamp trigger
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply update_updated_at trigger to relevant tables
CREATE TRIGGER update_candidates_updated_at BEFORE UPDATE ON candidates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_positions_updated_at BEFORE UPDATE ON positions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_trade_intents_updated_at BEFORE UPDATE ON trade_intents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_strategy_config_updated_at BEFORE UPDATE ON strategy_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- VIEWS: Useful views for analytics
-- ============================================================================

-- View: Open positions summary
CREATE OR REPLACE VIEW v_open_positions AS
SELECT 
    p.*,
    c.signal_type,
    c.candidate_json->>'currentPrice' as current_price,
    EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - p.created_at)) / 3600 as hours_open
FROM positions p
LEFT JOIN candidates c ON p.candidate_id = c.id
WHERE p.status = 'open'
ORDER BY p.opened_at_ms DESC;

-- View: PnL summary
CREATE OR REPLACE VIEW v_pnl_summary AS
SELECT
    COUNT(*) as total_positions,
    COUNT(CASE WHEN status = 'closed' AND pnl_usdt > 0 THEN 1 END) as wins,
    COUNT(CASE WHEN status = 'closed' AND pnl_usdt <= 0 THEN 1 END) as losses,
    ROUND(
        COUNT(CASE WHEN status = 'closed' AND pnl_usdt > 0 THEN 1 END)::NUMERIC / 
        NULLIF(COUNT(CASE WHEN status = 'closed' THEN 1 END), 0) * 100, 
        2
    ) as win_rate_percent,
    SUM(CASE WHEN status = 'closed' THEN pnl_usdt ELSE 0 END) as total_pnl_usdt,
    AVG(CASE WHEN status = 'closed' AND pnl_usdt > 0 THEN pnl_usdt END) as avg_win_usdt,
    AVG(CASE WHEN status = 'closed' AND pnl_usdt <= 0 THEN pnl_usdt END) as avg_loss_usdt,
    COUNT(CASE WHEN status = 'open' THEN 1 END) as open_count
FROM positions;

-- View: Recent signals
CREATE OR REPLACE VIEW v_recent_signals AS
SELECT 
    c.id,
    c.symbol,
    c.signal_type,
    c.direction,
    c.status,
    c.candidate_json->>'entry' as entry_price,
    c.candidate_json->>'stopLoss' as stop_loss,
    c.candidate_json->>'takeProfit' as take_profit,
    c.candidate_json->'entryConfirmation'->>'confirmed' as entry_confirmed,
    c.candidate_json->'entryConfirmation'->>'score' as confirmation_score,
    c.created_at
FROM candidates c
ORDER BY c.created_at DESC
LIMIT 100;

-- ============================================================================
-- COMMENTS: Table and column documentation
-- ============================================================================

COMMENT ON TABLE candidates IS 'Enriched market signals from technical analysis';
COMMENT ON TABLE decisions IS 'LLM decisions for individual candidates';
COMMENT ON TABLE batch_decisions IS 'LLM batch decisions evaluating multiple candidates';
COMMENT ON TABLE positions IS 'Trading positions (both dry-run and live)';
COMMENT ON TABLE trades IS 'Trade execution log for audit trail';
COMMENT ON TABLE trade_intents IS 'Pending trade intents for confirm mode';
COMMENT ON TABLE strategy_config IS 'Strategy configuration stored as key-value pairs';
COMMENT ON TABLE learning_lessons IS 'Learning lessons extracted from trading history';
COMMENT ON TABLE watchlist IS 'List of symbols to monitor';
COMMENT ON TABLE watch_alerts IS 'Track watch alerts to prevent duplicate notifications';

COMMENT ON COLUMN positions.execution_mode IS 'Trading mode: dry_run, confirm, or live';
COMMENT ON COLUMN positions.trailing_armed IS 'Whether trailing stop has been armed (price reached TP threshold)';
COMMENT ON COLUMN positions.partial_tp_done IS 'Whether partial take profit has been executed';
COMMENT ON COLUMN candidates.candidate_json IS 'Full candidate data as JSONB for flexibility';
COMMENT ON COLUMN watch_alerts.last_sent_at_ms IS 'Timestamp of last alert sent (for deduplication)';
