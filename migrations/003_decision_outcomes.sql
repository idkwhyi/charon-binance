-- PostgreSQL Migration: Decision Outcomes (automatic feedback loop)
-- Version: 2.4.0
-- Date: 2026-07-25
--
-- Denormalized record joining candidate features + decision + final trade
-- outcome, written automatically when a position closes (see
-- src/db/learning.js:recordDecisionOutcome, hooked from closePosition()).
-- Replaces manual /lesson entries as the source of truth for training data
-- and confidence-calibration analysis (/stats confidence).

CREATE TABLE IF NOT EXISTS decision_outcomes (
    id SERIAL PRIMARY KEY,
    position_id INTEGER NOT NULL UNIQUE REFERENCES positions(id) ON DELETE CASCADE,
    candidate_id INTEGER REFERENCES candidates(id) ON DELETE SET NULL,
    decision_id INTEGER REFERENCES decisions(id) ON DELETE SET NULL,
    symbol VARCHAR(20) NOT NULL,
    signal_type VARCHAR(50),
    direction VARCHAR(10),
    strategy_id VARCHAR(50),
    execution_mode VARCHAR(20),
    verdict VARCHAR(50),
    confidence INTEGER,
    candidate_features_json JSONB,
    leverage INTEGER,
    entry_price DECIMAL(20, 8),
    exit_price DECIMAL(20, 8),
    entry_usdt DECIMAL(20, 8),
    tp_percent DECIMAL(10, 4),
    sl_percent DECIMAL(10, 4),
    pnl_percent DECIMAL(10, 4),
    pnl_usdt DECIMAL(20, 8),
    exit_reason TEXT,
    r_multiple DECIMAL(10, 4),
    hold_time_ms BIGINT,
    opened_at_ms BIGINT,
    closed_at_ms BIGINT,
    created_at_ms BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_decision_outcomes_symbol ON decision_outcomes(symbol);
CREATE INDEX IF NOT EXISTS idx_decision_outcomes_signal_type ON decision_outcomes(signal_type);
CREATE INDEX IF NOT EXISTS idx_decision_outcomes_confidence ON decision_outcomes(confidence);
CREATE INDEX IF NOT EXISTS idx_decision_outcomes_strategy_id ON decision_outcomes(strategy_id);
CREATE INDEX IF NOT EXISTS idx_decision_outcomes_created_at_ms ON decision_outcomes(created_at_ms);

COMMENT ON TABLE decision_outcomes IS 'Automatic feature+decision+outcome record per closed position, for confidence calibration and future ML training data';
COMMENT ON COLUMN decision_outcomes.candidate_features_json IS 'Snapshot of candidates.candidate_json at signal time (technical indicator features)';
COMMENT ON COLUMN decision_outcomes.r_multiple IS 'pnl_usdt divided by the initial risk (entry_usdt * leverage * |sl_percent| / 100)';
