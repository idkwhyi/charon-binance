-- PostgreSQL Migration: rename exit reason LIQUIDATION_GUARD -> LIQ_GUARD
-- Date: 2026-10-04
--
-- The exit reason was renamed in code. Rows written before that (live path
-- only — dry-run never stored a liq_price) keep the old name; normalize them
-- so reports group both under LIQ_GUARD. Idempotent.

UPDATE positions         SET exit_reason = 'LIQ_GUARD' WHERE exit_reason = 'LIQUIDATION_GUARD';
UPDATE trades            SET reason      = 'LIQ_GUARD' WHERE reason      = 'LIQUIDATION_GUARD';
UPDATE decision_outcomes SET exit_reason = 'LIQ_GUARD' WHERE exit_reason = 'LIQUIDATION_GUARD';
UPDATE backtest_positions SET exit_reason = 'LIQ_GUARD' WHERE exit_reason = 'LIQUIDATION_GUARD';
