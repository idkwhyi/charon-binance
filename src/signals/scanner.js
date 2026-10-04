import WebSocket from 'ws';
import { BINANCE_FUTURES_WS_URL, KLINE_STRICT_CONTINUITY_CANDLES } from '../config.js';
import { fetchKlines, fetchKlinesSince, fetchPremiumIndex, fetchOpenInterest, fetchTicker24h } from '../enrichment/binance.js';
import { runIndicators } from './indicators.js';
import { activeStrategy } from '../db/settings.js';
import { getWatchlist } from '../db/watchlist.js';
import { sendWatchAlert } from '../telegram/send.js';
import { now } from '../utils.js';
import { closedOnly, mergeCandle, parseClosedKlineMessage, findGaps, INTERVAL_MS, gapKey, confirmExchangeGaps, classifyGaps } from './klineCache.js';
import { recordSignalEvent } from '../db/signalEvents.js';
import { SIGNAL_TYPE_REJECT } from './extremeOB.js';
import { markDetectorOutcome } from '../pipeline/dedup.js';

let cycleHandler = null;
let ws = null;
let wsReconnectTimer = null;
const klineCache = new Map(); // symbol → { '1h': klines[], '15m': klines[] }
const exchangeGaps = new Map(); // `${symbol}:${interval}` → Set(gapKey) confirmed missing on Binance

// Deduplicate watch alerts — same symbol+direction+OB zone max once per 30 min
// Key format: "SYMBOL:DIRECTION:OBLOW-OBHIGH"
// This allows different OB zones on the same symbol to send separate alerts
const watchAlertSeen = new Map();

/**
 * Register the handler that receives every triggered signal from one scan
 * cycle at once (so a selector can pick across symbols, not first-come).
 * @param {(rawSignals: object[]) => Promise<void>} fn
 */
export function setCycleHandler(fn) {
  cycleHandler = fn;
}

/**
 * Fetch initial klines for all watchlist symbols (1h and 15m).
 */
export async function warmupKlines() {
  const watchlist = await getWatchlist();
  console.log(`[scanner] warming up klines for ${watchlist.length} symbols (1h + 15m)...`);
  for (const symbol of watchlist) {
    try {
      const k1h = await fetchKlines(symbol, '1h', 100);
      const k15m = await fetchKlines(symbol, '15m', 100);
      klineCache.set(symbol, { '1h': k1h, '15m': k15m });
    } catch (err) {
      console.log(`[scanner] warmup ${symbol}: ${err.message}`);
    }
  }
  console.log(`[scanner] warmup done`);
}

/**
 * Scan all symbols in watchlist using cached 1h + 15m klines + live enrichment.
 */
export async function scanSignals() {
  const strat = await activeStrategy();
  const allowedSignals = (strat.signal_types || '').split(',').map(s => s.trim());
  const watchlist = await getWatchlist();

  console.log(`[scanner] scan start | strategy=${strat.id} | allowed=${allowedSignals.join(',')} | symbols=${watchlist.length}`);

  let totalSignals = 0;
  let totalTriggered = 0;
  const cycleSignals = [];

  for (const symbol of watchlist) {
    try {
      const cache = klineCache.get(symbol) || {};
      let klines1h = cache['1h'];
      let klines15m = cache['15m'];

      // Fetch if missing or insufficient
      if (!klines1h || klines1h.length < 25) {
        klines1h = await fetchKlines(symbol, '1h', 100);
      }
      if (!klines15m || klines15m.length < 25) {
        klines15m = await fetchKlines(symbol, '15m', 100);
      }
      
      // Defense in depth: indicators only ever see closed candles
      const t = now();
      klines1h = closedOnly(klines1h, t);
      klines15m = closedOnly(klines15m, t);
      klineCache.set(symbol, { '1h': klines1h, '15m': klines15m });

      // Continuity: backfill holes over REST; if still not continuous, skip this symbol this cycle
      const gaps = {};
      for (const interval of ['1h', '15m']) {
        const g = await ensureContinuous(symbol, interval, t);
        if (g.length) gaps[interval] = g;
      }
      if (Object.keys(gaps).length) {
        const summary = Object.entries(gaps).map(([iv, g]) => `${iv}: ${g.reduce((n, x) => n + x.count, 0)} missing`).join(', ');
        // strict last-N window or an unconfirmed hole — see classifyGaps
        console.log(`[scanner] ${symbol} skipped: data gap after backfill (${summary})`);
        recordSignalEvent({ symbol, klines15m: klineCache.get(symbol)['15m'] }, {
          stage: 'data', outcome: 'rejected', reasonCode: 'DATA_GAP', reason: `kline gap after backfill (${summary})`, details: { gaps },
        });
        continue;
      }
      klines1h = klineCache.get(symbol)['1h'];
      klines15m = klineCache.get(symbol)['15m'];

      // Fetch funding rate
      let fundingRate = null;
      try {
        const premium = await fetchPremiumIndex(symbol);
        fundingRate = Number(premium.lastFundingRate || 0);
      } catch { /* ignore */ }

      // Run all indicators with both timeframes
      const allSignals = runIndicators(klines1h, klines15m, fundingRate, strat);

      // Separate watch alerts and detector rejects from actionable signals
      const watchSignals  = allSignals.filter(s => s.type === 'extreme_ob_watch');
      const rejectSignals = allSignals.filter(s => s.type === SIGNAL_TYPE_REJECT);
      const triggered     = allSignals.filter(s => allowedSignals.includes(s.type));

      // Evaluation log: detector-level outcomes (one row per setup per 15m candle)
      if (allowedSignals.includes('extreme_ob')) {
        for (const sig of rejectSignals) {
          markDetectorOutcome(symbol, sig, klines15m, t); // rejected setups stay deduped for this candle
          recordSignalEvent({ symbol, direction: sig.direction, signalType: 'extreme_ob', klines15m }, {
            stage: 'detector', outcome: 'rejected', reasonCode: sig.meta.reasonCode, reason: sig.meta.reason,
          });
        }
        for (const sig of watchSignals) {
          const waitingForZone = sig.meta.waitingFor === 'price_in_ob_zone';
          recordSignalEvent({ symbol, direction: sig.direction, signalType: 'extreme_ob', klines15m }, {
            stage: 'detector', outcome: 'watch',
            reasonCode: waitingForZone ? 'not_in_ob_zone' : 'confirmation_score',
            reason: waitingForZone
              ? 'waiting for price to retrace into the OB zone'
              : `confirmation score ${sig.meta.entryConfirmation?.score}/${sig.meta.entryConfirmation?.maxScore}: ${sig.meta.confirmationNeeded}`,
            details: { rrRatio: sig.meta.rrRatio, score: sig.meta.entryConfirmation?.score },
          });
        }
      }

      // Send watch alerts (deduplicated per 30 min based on symbol + direction only)
      for (const watchSig of watchSignals) {
        // Simplified deduplication: same symbol + direction within 30 min
        // This prevents multiple alerts for the same setup even if OB zone shifts slightly
        const watchKey = `${symbol}:${watchSig.direction}`;
        
        const lastSent = watchAlertSeen.get(watchKey) || 0;
        if (now() - lastSent > 30 * 60_000) {
          watchAlertSeen.set(watchKey, now());
          sendWatchAlert(symbol, watchSig.direction, watchSig.meta).catch(() => {});
          console.log(`[scanner] watch alert sent: ${watchKey}`);
        } else {
          const minutesAgo = Math.floor((now() - lastSent) / 60_000);
          console.log(`[scanner] watch alert skipped (sent ${minutesAgo}m ago): ${watchKey}`);
        }
      }

      totalSignals += allSignals.length - rejectSignals.length;

      if (triggered.length === 0) continue;

      totalTriggered += triggered.length;

      // Fetch enrichment data
      const ticker = await fetchTicker24h(symbol);
      const oi = await fetchOpenInterest(symbol).catch(() => null);

      // Collect each triggered signal; handed to the cycle handler after the loop
      for (const signal of triggered) {
        cycleSignals.push({
          symbol,
          signalType: signal.type,
          direction: signal.direction,
          signalMeta: signal.meta,
          ticker,
          klines1h,
          klines15m,
          fundingRate,
          openInterest: oi ? Number(oi.openInterest) : null,
          detectedAt: now(),
        });
      }
    } catch (err) {
      console.log(`[scanner] ${symbol}: ${err.message}`);
    }
  }

  if (cycleHandler && cycleSignals.length > 0) {
    await cycleHandler(cycleSignals);
  }

  console.log(`[scanner] scan done | signals_detected=${totalSignals} | triggered=${totalTriggered}`);
}

/**
 * Put a closed WebSocket kline into the cache, replacing any copy with the
 * same openTime (e.g. one fetched over REST) instead of appending a duplicate.
 */
export function applyClosedKline({ symbol, interval, candle }) {
  const cache = klineCache.get(symbol) || { '1h': [], '15m': [] };
  cache[interval] = mergeCandle(cache[interval] || [], candle, 100);
  klineCache.set(symbol, cache);
}

/**
 * Make the cached series for symbol+interval continuous up to the latest
 * closed candle. Holes not already known to be exchange-side are backfilled
 * over REST from the openTime of the last closed candle before the first one
 * and merged by openTime. Holes the response confirms Binance doesn't have
 * are remembered (logged once as EXCHANGE_GAP) and not refetched.
 * The result is judged by classifyGaps (strict last-N rule, shared with the
 * backtest).
 * @returns {Promise<Array>} blocking holes (empty = usable this cycle)
 */
export async function ensureContinuous(symbol, interval, nowMs = now()) {
  return (await continuityStatus(symbol, interval, nowMs)).blocking;
}

export async function continuityStatus(symbol, interval, nowMs = now()) {
  const intervalMs = INTERVAL_MS[interval];
  const knownKey = `${symbol}:${interval}`;
  if (!exchangeGaps.has(knownKey)) exchangeGaps.set(knownKey, new Set());
  const known = exchangeGaps.get(knownKey);
  const judge = (series, newlyConfirmed = []) => {
    const c = classifyGaps(findGaps(series, intervalMs, nowMs), { intervalMs, nowMs, strictCandles: KLINE_STRICT_CONTINUITY_CANDLES, exchangeGapKeys: known });
    return { ...c, blocking: [...c.strict, ...c.data], newlyConfirmed };
  };

  const cached = (klineCache.get(symbol) || {})[interval] || [];
  const unknown = findGaps(cached, intervalMs, nowMs).filter(g => !known.has(gapKey(g)));
  if (!unknown.length) return judge(cached);

  try {
    const fetched = await fetchKlinesSince(symbol, interval, unknown[0].afterOpenTime, intervalMs, nowMs);
    let merged = cached;
    for (const candle of fetched) merged = mergeCandle(merged, candle, 100);
    const cache = klineCache.get(symbol) || { '1h': [], '15m': [] };
    cache[interval] = merged;
    klineCache.set(symbol, cache);

    const remaining = findGaps(merged, intervalMs, nowMs).filter(g => !known.has(gapKey(g)));
    const newlyConfirmed = confirmExchangeGaps(remaining, fetched);
    for (const g of newlyConfirmed) {
      known.add(gapKey(g));
      console.log(`[scanner] ${symbol} ${interval}: exchange has no candles ${new Date(g.fromOpenTime).toISOString()} → ${new Date(g.toOpenTime).toISOString()} (${g.count}), accepted`);
      recordSignalEvent({ symbol, klines15m: (klineCache.get(symbol) || {})['15m'] }, {
        stage: 'data', outcome: 'accepted', reasonCode: 'EXCHANGE_GAP',
        reason: `${interval}: Binance has no candles for ${g.count} interval(s) from ${new Date(g.fromOpenTime).toISOString()}`,
        details: { interval, gap: g },
      });
    }
    return judge(merged, newlyConfirmed);
  } catch (err) {
    console.log(`[scanner] backfill ${symbol} ${interval} failed: ${err.message}`);
    return judge(cached);
  }
}

/** Test helper: forget confirmed exchange-side holes. */
export function _exchangeGapsForTest() {
  return exchangeGaps;
}

/** Backfill every cached symbol (called on each WebSocket (re)connect). */
export async function backfillAll(nowMs = now()) {
  let filled = 0;
  for (const symbol of klineCache.keys()) {
    for (const interval of ['1h', '15m']) {
      const known = exchangeGaps.get(`${symbol}:${interval}`) || new Set();
      const before = findGaps((klineCache.get(symbol) || {})[interval] || [], INTERVAL_MS[interval], nowMs)
        .filter(g => !known.has(gapKey(g))).length;
      if (!before) continue;
      const after = await ensureContinuous(symbol, interval, nowMs);
      if (!after.length) filled++;
    }
  }
  if (filled) console.log(`[scanner] backfilled ${filled} series after (re)connect`);
}

/** Test helper: read/reset the in-memory kline cache. */
export function _klineCacheForTest() {
  return klineCache;
}

/**
 * Start Binance Futures WebSocket — 1h and 15m kline streams.
 */
export async function startWebSocket() {
  async function connect() {
    const watchlist = await getWatchlist();
    const streams = [];
    
    // Add both 1h and 15m streams for each symbol
    for (const sym of watchlist) {
      streams.push(`${sym.toLowerCase()}@kline_1h`);
      streams.push(`${sym.toLowerCase()}@kline_15m`);
    }
    
    const wsUrl = `${BINANCE_FUTURES_WS_URL}/stream?streams=${streams.join('/')}`;
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log(`[scanner] WebSocket connected (${watchlist.length} symbols, 1h + 15m)`);
      // Candles that closed while disconnected never arrive over the stream
      backfillAll().catch(err => console.log(`[scanner] backfill after connect failed: ${err.message}`));
    });

    ws.on('message', (raw) => {
      try {
        const parsed = parseClosedKlineMessage(raw);
        if (!parsed) return; // not a kline, or still forming
        applyClosedKline(parsed);
      } catch { /* ignore */ }
    });

    ws.on('error', (err) => {
      console.log(`[scanner] WebSocket error: ${err.message}`);
    });

    ws.on('close', () => {
      console.log('[scanner] WebSocket closed, reconnecting in 5s...');
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(connectSafely, 5_000);
    });
  }

  function connectSafely() {
    connect().catch(err => {
      console.log(`[scanner] WebSocket connect failed: ${err.message}, retrying in 5s...`);
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(connectSafely, 5_000);
    });
  }

  connectSafely();
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
