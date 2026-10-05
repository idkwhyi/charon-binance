import dotenv from 'dotenv';
import { validateStrictContinuity } from './signals/klineCache.js';
dotenv.config();

export const APP_NAME = 'Charon Binance Futures';

// PostgreSQL (required)
export const PG_HOST = process.env.PG_HOST || 'localhost';
export const PG_PORT = Number(process.env.PG_PORT || 5432);
export const PG_DATABASE = process.env.PG_DATABASE || 'endelif';
export const PG_USER = process.env.PG_USER || 'postgres';
export const PG_PASSWORD = process.env.PG_PASSWORD || '';
export const PG_POOL_MAX = Number(process.env.PG_POOL_MAX || 20);
export const USE_POSTGRES = true; // Always use PostgreSQL

// Telegram
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Binance Futures
export const BINANCE_API_KEY = process.env.BINANCE_API_KEY || '';
export const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || '';
export const BINANCE_FUTURES_BASE_URL = process.env.BINANCE_FUTURES_BASE_URL || 'https://fapi.binance.com';
export const BINANCE_FUTURES_WS_URL = process.env.BINANCE_FUTURES_WS_URL || 'wss://fstream.binance.com';

// Trading
export const TRADING_MODE = process.env.TRADING_MODE || 'dry_run'; // dry_run | confirm | live
export const TRADE_AMOUNT_USDT = Number(process.env.TRADE_AMOUNT_USDT || 10); // fallback margin if balance lookup fails
export const LIVE_MIN_USDT_RESERVE = Number(process.env.LIVE_MIN_USDT_RESERVE || 20);
export const MARGIN_TYPE = process.env.MARGIN_TYPE || 'ISOLATED'; // ISOLATED | CROSSED

// Risk-based position sizing: $ risked per trade = availableBalance * RISK_PERCENT_PER_TRADE / 100,
// independent of leverage. Leverage only reduces the margin locked for the resulting notional —
// see src/pipeline/positionSizing.js.
export const RISK_PERCENT_PER_TRADE = Number(process.env.RISK_PERCENT_PER_TRADE || 1);
// Safety cap: skip a trade if the margin its risk-sized notional would require exceeds this % of
// available balance (protects against very tight SL distances demanding an oversized position).
export const MAX_MARGIN_PERCENT_PER_TRADE = Number(process.env.MAX_MARGIN_PERCENT_PER_TRADE || 50);

// Portfolio risk gates (src/pipeline/riskControls.js)
// Stop opening new positions once today's realized PnL <= -DAILY_LOSS_LIMIT_PERCENT
// of the start-of-day balance; resets at 00:00 UTC (07:00 WIB).
export const DAILY_LOSS_LIMIT_PERCENT = Number(process.env.DAILY_LOSS_LIMIT_PERCENT || 3);
export const MAX_SAME_DIRECTION_POSITIONS = Number(process.env.MAX_SAME_DIRECTION_POSITIONS || 2);

// Kline continuity (src/signals/klineCache.js classifyGaps): the last N candles per
// timeframe must be continuous with no exceptions; older holes are accepted only
// when the exchange confirms it has no candles there. Same rule live and backtest.
export const KLINE_STRICT_CONTINUITY_CANDLES_15M = Number(process.env.KLINE_STRICT_CONTINUITY_CANDLES_15M || 20);
export const KLINE_STRICT_CONTINUITY_CANDLES_1H = Number(process.env.KLINE_STRICT_CONTINUITY_CANDLES_1H || 6);
export const KLINE_STRICT_CONTINUITY = { '15m': KLINE_STRICT_CONTINUITY_CANDLES_15M, '1h': KLINE_STRICT_CONTINUITY_CANDLES_1H };

// Fill simulation (src/execution/simulation.js) — the ONE cost model, used by
// both dry-run and the backtest.
export const SIM_SLIPPAGE_PERCENT = Number(process.env.SIM_SLIPPAGE_PERCENT || 0.03); // per side, adverse
export const SIM_TAKER_FEE_PERCENT = Number(process.env.SIM_TAKER_FEE_PERCENT || 0.05); // per side

// LLM
export const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
export const LLM_API_KEY = process.env.LLM_API_KEY || '';
export const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 60_000);
export const ENABLE_LLM = process.env.ENABLE_LLM !== 'false';
// LLM is out of the trade decision path unless explicitly enabled here AND the
// active strategy has use_llm: true. Otherwise a deterministic selector picks
// at most one candidate per scan cycle (src/pipeline/candidateSelector.js).
export const LLM_DECISION_ENABLED = process.env.LLM_DECISION_ENABLED === 'true';
export const LLM_CANDIDATE_PICK_COUNT = Number(process.env.LLM_CANDIDATE_PICK_COUNT || 10);

// Intervals
export const POSITION_CHECK_MS = Number(process.env.POSITION_CHECK_MS || 10_000);
export const SIGNAL_SCAN_MS = Number(process.env.SIGNAL_SCAN_MS || 30_000);

// Watchlist
export const WATCHLIST = (process.env.WATCHLIST || 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,DOTUSDT,LINKUSDT')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// Top Gainer Auto-Screening (dynamic universe). On/off only: the selection
// rules (top N, min volume, min |change|, COIN only) are UNIVERSE_RULES in
// src/universe/rules.js, shared with the backtest.
export const TOP_GAINER_ENABLED = process.env.TOP_GAINER_ENABLED !== 'false';

export const JSON_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': 'charon-binance/1.0',
};

export function validateConfig() {
  // Fail fast on a strict-continuity N outside 0 < N < kline window
  validateStrictContinuity(KLINE_STRICT_CONTINUITY);

  // PostgreSQL is required
  if (!PG_HOST) throw new Error('PG_HOST is required.');
  if (!PG_USER) throw new Error('PG_USER is required.');
  if (!PG_DATABASE) throw new Error('PG_DATABASE is required.');
  
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required.');
  if (!TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_CHAT_ID is required.');
  if (TRADING_MODE === 'live' || TRADING_MODE === 'confirm') {
    if (!BINANCE_API_KEY) throw new Error('BINANCE_API_KEY is required for live/confirm mode.');
    if (!BINANCE_API_SECRET) throw new Error('BINANCE_API_SECRET is required for live/confirm mode.');
  }
}
