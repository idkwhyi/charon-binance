import WebSocket from 'ws';
import { BINANCE_FUTURES_WS_URL } from '../config.js';
import { fetchKlines, fetchPremiumIndex, fetchOpenInterest, fetchTicker24h } from '../enrichment/binance.js';
import { runIndicators } from './indicators.js';
import { activeStrategy } from '../db/settings.js';
import { getWatchlist } from '../db/watchlist.js';
import { sendWatchAlert } from '../telegram/send.js';
import { now } from '../utils.js';

let candidateHandler = null;
let ws = null;
let wsReconnectTimer = null;
const klineCache = new Map(); // symbol → { '15m': klines[] }

// Deduplicate watch alerts — same symbol+direction max once per 30 min
const watchAlertSeen = new Map();

export function setCandidateHandler(fn) {
  candidateHandler = fn;
}

/**
 * Fetch initial klines for all watchlist symbols (15m only).
 */
export async function warmupKlines() {
  const watchlist = getWatchlist();
  console.log(`[scanner] warming up klines for ${watchlist.length} symbols...`);
  for (const symbol of watchlist) {
    try {
      const k15m = await fetchKlines(symbol, '15m', 100);
      klineCache.set(symbol, { '15m': k15m });
    } catch (err) {
      console.log(`[scanner] warmup ${symbol}: ${err.message}`);
    }
  }
  console.log(`[scanner] warmup done`);
}

/**
 * Scan all symbols in watchlist using cached 15m klines + live enrichment.
 */
export async function scanSignals() {
  const strat = activeStrategy();
  const allowedSignals = (strat.signal_types || '').split(',').map(s => s.trim());
  const watchlist = getWatchlist();

  console.log(`[scanner] scan start | strategy=${strat.id} | allowed=${allowedSignals.join(',')} | symbols=${watchlist.length}`);

  let totalSignals = 0;
  let totalTriggered = 0;

  for (const symbol of watchlist) {
    try {
      const cache = klineCache.get(symbol) || {};
      let klines15m = cache['15m'];

      if (!klines15m || klines15m.length < 25) {
        klines15m = await fetchKlines(symbol, '15m', 100);
        klineCache.set(symbol, { '15m': klines15m });
      }

      // Fetch funding rate
      let fundingRate = null;
      try {
        const premium = await fetchPremiumIndex(symbol);
        fundingRate = Number(premium.lastFundingRate || 0);
      } catch { /* ignore */ }

      // Run all indicators on 15m klines
      const allSignals = runIndicators(klines15m, fundingRate, strat);

      // Separate watch alerts from actionable signals
      const watchSignals = allSignals.filter(s => s.type === 'extreme_ob_watch');
      const triggered    = allSignals.filter(s => allowedSignals.includes(s.type));

      // Send watch alerts (deduplicated per 30 min)
      for (const watchSig of watchSignals) {
        const watchKey = `${symbol}:${watchSig.direction}`;
        const lastSent = watchAlertSeen.get(watchKey) || 0;
        if (now() - lastSent > 30 * 60_000) {
          watchAlertSeen.set(watchKey, now());
          sendWatchAlert(symbol, watchSig.direction, watchSig.meta).catch(() => {});
        }
      }

      totalSignals += allSignals.length;

      if (triggered.length === 0) continue;

      totalTriggered += triggered.length;

      // Fetch enrichment data
      const ticker = await fetchTicker24h(symbol);
      const oi = await fetchOpenInterest(symbol).catch(() => null);

      // Emit each triggered signal as candidate
      for (const signal of triggered) {
        if (candidateHandler) {
          await candidateHandler({
            symbol,
            signalType: signal.type,
            direction: signal.direction,
            signalMeta: signal.meta,
            ticker,
            klines15m,
            fundingRate,
            openInterest: oi ? Number(oi.openInterest) : null,
            detectedAt: now(),
          });
        }
      }
    } catch (err) {
      console.log(`[scanner] ${symbol}: ${err.message}`);
    }
  }

  console.log(`[scanner] scan done | signals_detected=${totalSignals} | triggered=${totalTriggered}`);
}

/**
 * Start Binance Futures WebSocket — 15m kline streams only.
 */
export function startWebSocket() {
  function connect() {
    const watchlist = getWatchlist();
    const streams = watchlist.map(sym => `${sym.toLowerCase()}@kline_15m`);
    const wsUrl = `${BINANCE_FUTURES_WS_URL}/stream?streams=${streams.join('/')}`;
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log(`[scanner] WebSocket connected (${watchlist.length} symbols, 15m)`);
    });

    ws.on('message', (raw) => {
      try {
        const msg  = JSON.parse(raw);
        const data = msg.data;
        if (!data || data.e !== 'kline') return;
        const k = data.k;
        if (!k.x) return; // Only closed candles

        const symbol = k.s;
        const candle = {
          openTime:    k.t,
          open:        Number(k.o),
          high:        Number(k.h),
          low:         Number(k.l),
          close:       Number(k.c),
          volume:      Number(k.v),
          closeTime:   k.T,
          quoteVolume: Number(k.q),
        };

        const cache = klineCache.get(symbol) || { '15m': [] };
        const arr   = cache['15m'];
        arr.push(candle);
        if (arr.length > 100) arr.shift();
        cache['15m'] = arr;
        klineCache.set(symbol, cache);
      } catch { /* ignore */ }
    });

    ws.on('error', (err) => {
      console.log(`[scanner] WebSocket error: ${err.message}`);
    });

    ws.on('close', () => {
      console.log('[scanner] WebSocket closed, reconnecting in 5s...');
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(connect, 5_000);
    });
  }

  connect();
}

/**
 * Reconnect WebSocket (call after watchlist changes).
 */
export function reconnectWebSocket() {
  if (ws) {
    ws.removeAllListeners();
    ws.terminate();
    ws = null;
  }
  clearTimeout(wsReconnectTimer);
  startWebSocket();
}
