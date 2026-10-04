-- PostgreSQL Migration: signal evaluation log
-- Date: 2026-10-04
--
-- One row per (setup, 15m candle, stage, reason): what happened to every
-- signal — rejected by the detector (funding, R:R, ...), watched (waiting for
-- OB zone / confirmation score), rejected in the pipeline (dedup, filters,
-- position caps, daily limit, entry re-plan, ...) or executed.

CREATE TABLE IF NOT EXISTS signal_events (
    id SERIAL PRIMARY KEY,
    at_ms BIGINT NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    direction VARCHAR(10),
    signal_type VARCHAR(50),
    candle_close_ms BIGINT,
    stage VARCHAR(20) NOT NULL,       -- detector | pipeline | entry
    outcome VARCHAR(30) NOT NULL,     -- executed | rejected | watch | pending_confirmation
    reason_code VARCHAR(50) NOT NULL,
    reason TEXT,
    candidate_id INTEGER REFERENCES candidates(id) ON DELETE SET NULL,
    position_id INTEGER REFERENCES positions(id) ON DELETE SET NULL,
    details_json JSONB
);

-- The scanner re-evaluates every 30s; keep one row per setup/candle/stage/reason.
CREATE UNIQUE INDEX IF NOT EXISTS uq_signal_events_once_per_candle ON signal_events (
    symbol, COALESCE(direction, ''), COALESCE(signal_type, ''), COALESCE(candle_close_ms, 0), stage, reason_code
);
CREATE INDEX IF NOT EXISTS idx_signal_events_at ON signal_events (at_ms);
CREATE INDEX IF NOT EXISTS idx_signal_events_outcome ON signal_events (outcome, reason_code);
