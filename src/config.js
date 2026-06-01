import dotenv from 'dotenv';
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
export const TRADE_AMOUNT_USDT = Number(process.env.TRADE_AMOUNT_USDT || 10);
export const LIVE_MIN_USDT_RESERVE = Number(process.env.LIVE_MIN_USDT_RESERVE || 20);
export const MARGIN_TYPE = process.env.MARGIN_TYPE || 'ISOLATED'; // ISOLATED | CROSSED

// LLM
export const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
export const LLM_API_KEY = process.env.LLM_API_KEY || '';
export const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 60_000);
export const ENABLE_LLM = process.env.ENABLE_LLM !== 'false';
export const LLM_CANDIDATE_PICK_COUNT = Number(process.env.LLM_CANDIDATE_PICK_COUNT || 10);

// Intervals
export const POSITION_CHECK_MS = Number(process.env.POSITION_CHECK_MS || 10_000);
export const SIGNAL_SCAN_MS = Number(process.env.SIGNAL_SCAN_MS || 30_000);

// Watchlist
export const WATCHLIST = (process.env.WATCHLIST || 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,DOTUSDT,LINKUSDT')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// Top Gainer Auto-Screening
export const TOP_GAINER_ENABLED = process.env.TOP_GAINER_ENABLED !== 'false';
export const TOP_GAINER_COUNT = Number(process.env.TOP_GAINER_COUNT || 50);
export const TOP_GAINER_MIN_VOLUME_USDT = Number(process.env.TOP_GAINER_MIN_VOLUME_USDT || 50_000_000);
export const TOP_GAINER_REFRESH_MS = Number(process.env.TOP_GAINER_REFRESH_MS || 300_000);

export const JSON_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': 'charon-binance/1.0',
};

export function validateConfig() {
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
