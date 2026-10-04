-- PostgreSQL Migration: per-trade fill details for realistic dry-run
-- Date: 2026-10-04
--
-- Dry-run positions now simulate slippage and taker fees and detect SL/TP on
-- 1m candle high/low. These columns record what each trade actually paid.

ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_mark_price DECIMAL(20, 8);       -- pre-slippage entry reference
ALTER TABLE positions ADD COLUMN IF NOT EXISTS stop_loss_price DECIMAL(20, 8);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS take_profit_price DECIMAL(20, 8);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS risk_usdt DECIMAL(20, 8);              -- 1R = qty x |entry - SL|
ALTER TABLE positions ADD COLUMN IF NOT EXISTS exit_price_raw DECIMAL(20, 8);         -- pre-slippage exit reference
ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_fee_usdt DECIMAL(20, 8);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS exit_fee_usdt DECIMAL(20, 8);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS slippage_usdt DECIMAL(20, 8);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS pnl_r DECIMAL(10, 4);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS last_candle_checked_ms BIGINT;         -- last 1m candle evaluated for SL/TP
