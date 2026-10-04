-- PostgreSQL Migration: backtest R-multiples and signal outcomes
-- Date: 2026-10-04
--
-- The backtest report shows expectancy in R (net of fees and slippage) and
-- how many signals were rejected per reason code.

ALTER TABLE backtest_positions ADD COLUMN IF NOT EXISTS risk_usdt DECIMAL(20, 8);   -- 1R = qty x |entry - SL|
ALTER TABLE backtest_positions ADD COLUMN IF NOT EXISTS pnl_r DECIMAL(10, 4);       -- net PnL / risk_usdt
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS signal_outcomes_json JSONB;      -- [{ symbol, direction, stage, outcome, reason_code, count }]
