-- PostgreSQL Migration: store position quantity
-- Date: 2026-10-04
--
-- notional_usdt previously stored the margin (entry_usdt), not margin x leverage,
-- and the live exit derived quantity from it — closing only 1/leverage of the
-- position. Quantity is now stored at entry and reused verbatim at exit.

ALTER TABLE positions ADD COLUMN IF NOT EXISTS quantity DECIMAL(30, 12);
