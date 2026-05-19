import WebSocket from 'ws';
import { BINANCE_FUTURES_WS_URL } from '../config.js';
import { fetchKlines, fetchPremiumIndex, fetchOpenInterest, fetchTicker24h } from '../enrichment/binance.js';
import { runIndicators } from './indicators.js';
import { activeStrategy } from '../db/settings.js';
import { getWatchlist } from '../db/watchlist.js';
import { now } from '../utils.js';

let candidateHandler = null;
let ws = null;
let wsReconnectTimer = null;
const klineCache = new Map(); // symbol → { '5m': klines[], '15m': klines[] }

export function setCandidateHandler(fn) {
  candidateHandler = fn;
}

/**
 * Fetch initial klines for all watchlist symbols.
 */
export async function warmupKlines() {
  const watchlist = getWatchlist();
  console.log(`[scanner] warming up klines for ${watchlist.length} symbols...`);
  for (const symbol of watchlist) {
    try {
      const k5m  = await fetchKlines(symbol, '5m',  50);
      const k15m = await fetchKlines(symbol, '15m', 50);
      klineCache.set(symbol, { '5m': k5m, '15m': k15m });
    } catch (err) {
      console.log(`[scanner] warmup ${symbol}: ${err.message}`);
    }
  }
  console.log(`[scanner] warmup done`);
}

/**
 * Scan all symbols in watchlist using cached klines + live enrichment.
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
      let klines5m  = cache['5m'];
      let klines15m = cache['15m'];

      if (!klines5m || klines5m.length < 25) {
        // Refresh cache
        klines5m  = await fetchKlines(symbol, '5m',  50);
        klines15m = await fetchKlines(symbol, '15m', 50);
        klineCache.set(symbol, { '5m': klines5m, '15m': klines15m });
      }

      // Fetch funding rate
      let fundingRate = null;
      try {
        const premium = await fetchPremiumIndex(symbol);
        fundingRate = Number(premium.lastFundingRate || 0);
      } catch { /* ignore */ }

      // Run indicators on 5m klines (pass 15m for market structure / extreme OB)
      const signals5m  = runIndicators(klines5m, fundingRate, strat, klines15m);
      // Run 15m-only indicators (RSI, EMA on higher TF) — no 15m arg to avoid duplicate OB
      const signals15m = runIndicators(klines15m, null, strat);

      // Merge signals, prefer 15m RSI over 5m RSI; extreme_ob comes from 5m pass
      const allSignals = [...signals5m];
      for (const s of signals15m) {
        if (!allSignals.find(x => x.type === s.type)) allSignals.push(s);
      }

      totalSignals += allSignals.length;

      // Filter to signals allowed by active strategy
      const triggered = allSignals.filter(s => allowedSignals.includes(s.type));
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
            klines5m,
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
 * Start Binance Futures WebSocket for kline updates.
 * Subscribes to 5m and 15m kline streams for all watchlist symbols.
 * Reconnects automatically when watchlist changes.
 */
export function startWebSocket() {
  function connect() {
    const watchlist = getWatchlist();
    const streams = watchlist.flatMap(sym => [
      `${sym.toLowerCase()}@kline_5m`,
      `${sym.toLowerCase()}@kline_15m`,
    ]);

    const wsUrl = `${BINANCE_FUTURES_WS_URL}/stream?streams=${streams.join('/')}`;
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log(`[scanner] WebSocket connected (${watchlist.length} symbols)`);
    });

    ws.on('message', (raw) => {
      try {
        const msg  = JSON.parse(raw);
        const data = msg.data;
        if (!data || data.e !== 'kline') return;
        const k = data.k;
        if (!k.x) return; // Only process closed candles

        const symbol   = k.s;
        const interval = k.i;
        const candle   = {
          openTime:    k.t,
          open:        Number(k.o),
          high:        Number(k.h),
          low:         Number(k.l),
          close:       Number(k.c),
          volume:      Number(k.v),
          closeTime:   k.T,
          quoteVolume: Number(k.q),
        };

        const cache = klineCache.get(symbol) || { '5m': [], '15m': [] };
        const arr   = cache[interval] || [];
        arr.push(candle);
        if (arr.length > 100) arr.shift(); // Keep last 100 candles
        cache[interval] = arr;
        klineCache.set(symbol, cache);
      } catch { /* ignore parse errors */ }
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
