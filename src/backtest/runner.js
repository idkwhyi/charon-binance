import { fetchKlinesRange, fetchFundingRateHistory } from '../enrichment/binance.js';
import { strategyById } from '../db/settings.js';
import { buildCandidate, filterCandidate } from '../pipeline/candidateBuilder.js';
import { runIndicators } from '../signals/indicators.js';
import {
  createBacktestRun, finishBacktestRun, openBacktestPosition,
  closeBacktestPosition, saveBacktestBalance,
} from '../db/backtest.js';

const TICK_MS = 15 * 60_000;
const WARMUP_1H_CANDLES = 30;
const WARMUP_15M_CANDLES = 30;
const KLINE_WINDOW = 100; // mirror the live scanner's rolling kline cache size

/**
 * Approximate a 24h ticker (used by buildCandidate/filterCandidate) from the
 * trailing 24 1h candles — there's no historical 24hr-ticker endpoint, so we
 * derive the same fields the live scanner gets from Binance's ticker API.
 */
function synthesizeTicker24h(klines1h) {
  const window = klines1h.slice(-24);
  if (window.length === 0) return { lastPrice: 0, price: 0, quoteVolume: 0, priceChangePercent: 0, highPrice: 0, lowPrice: 0 };
  const first = window[0];
  const last = window[window.length - 1];
  return {
    lastPrice: last.close,
    price: last.close,
    quoteVolume: window.reduce((s, k) => s + k.quoteVolume, 0),
    priceChangePercent: first.open > 0 ? (last.close - first.open) / first.open * 100 : 0,
    highPrice: Math.max(...window.map(k => k.high)),
    lowPrice: Math.min(...window.map(k => k.low)),
  };
}

function fundingRateAt(fundingHistory, tMs) {
  for (let i = fundingHistory.length - 1; i >= 0; i--) {
    if (fundingHistory[i].fundingTime <= tMs) return fundingHistory[i].fundingRate;
  }
  return null;
}

/**
 * TP/SL threshold prices from entry + raw (unleveraged) percent thresholds.
 * Mirrors the convention in src/execution/positions.js (refreshPosition):
 * tp_percent/sl_percent are raw price % from entry, not leverage-adjusted.
 */
function tpSlPrices(direction, entryPrice, tpPercent, slPercent) {
  if (direction === 'LONG') {
    return {
      tpPrice: entryPrice * (1 + tpPercent / 100),
      slPrice: entryPrice * (1 + slPercent / 100),
    };
  }
  return {
    tpPrice: entryPrice * (1 - tpPercent / 100),
    slPrice: entryPrice * (1 - slPercent / 100),
  };
}

/** Slippage always works against the trader, on both entry and exit. */
function applySlippage(price, direction, side, slippagePercent) {
  const factor = slippagePercent / 100;
  if (direction === 'LONG') return side === 'entry' ? price * (1 + factor) : price * (1 - factor);
  return side === 'entry' ? price * (1 - factor) : price * (1 + factor);
}

function pricePctFor(direction, entryPrice, exitPrice) {
  return direction === 'LONG'
    ? (exitPrice / entryPrice - 1) * 100
    : (1 - exitPrice / entryPrice) * 100;
}

function recordClose(balance, pnlUsdt, closedAtMs) {
  balance.balanceUsdt += pnlUsdt;
  balance.totalTrades++;
  if (pnlUsdt > 0) balance.winningTrades++; else balance.losingTrades++;
  balance.peakBalance = Math.max(balance.peakBalance, balance.balanceUsdt);
  const dd = (balance.peakBalance - balance.balanceUsdt) / balance.peakBalance * 100;
  balance.maxDrawdownPercent = Math.max(balance.maxDrawdownPercent, dd);
  balance.equityCurve.push({ t: closedAtMs, balance: balance.balanceUsdt });
}

/**
 * Replay historical klines through the exact same signal/filter pipeline the
 * live bot uses (runIndicators -> buildCandidate -> filterCandidate), then
 * simulate fills, TP/SL/max-hold exits, fees and slippage.
 *
 * Known simplifications vs. live trading (documented, not silently assumed):
 * - Decisions are rule-based only; the LLM screener is not invoked.
 * - At most one open position per symbol at a time.
 * - No liquidation or trailing-stop simulation.
 * - TP/SL priority on a same-candle double-touch is SL-first (pessimistic).
 */
export async function runBacktest(opts) {
  const {
    label = `backtest-${Date.now()}`,
    strategyId,
    symbols,
    dateFromMs,
    dateToMs,
    startingBalance = 1000,
    feePercent = 0.04,
    slippagePercent = 0.02,
  } = opts;

  const strat = await strategyById(strategyId);
  const allowedSignals = (strat.signal_types || '').split(',').map(s => s.trim());

  const runId = await createBacktestRun({
    label, strategyId, symbols, dateFromMs, dateToMs,
    startingBalance, feePercent, slippagePercent, params: {},
  });

  console.log(`[backtest] run #${runId} started: "${label}" | ${symbols.join(',')} | strategy=${strategyId}`);

  try {
    const warmupMs1h = WARMUP_1H_CANDLES * 60 * 60_000;
    const warmupMs15m = WARMUP_15M_CANDLES * 15 * 60_000;

    const data = {};
    for (const symbol of symbols) {
      console.log(`[backtest] fetching historical data for ${symbol}...`);
      const [klines1h, klines15m, funding] = await Promise.all([
        fetchKlinesRange(symbol, '1h', dateFromMs - warmupMs1h, dateToMs),
        fetchKlinesRange(symbol, '15m', dateFromMs - warmupMs15m, dateToMs),
        fetchFundingRateHistory(symbol, dateFromMs - warmupMs1h, dateToMs).catch(() => []),
      ]);
      data[symbol] = { klines1h, klines15m, funding, ptr1h: 0, ptr15m: 0 };
    }

    const balance = {
      balanceUsdt: startingBalance,
      availableBalance: startingBalance,
      marginUsed: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      maxDrawdownPercent: 0,
      peakBalance: startingBalance,
      equityCurve: [],
    };
    const openPositions = [];
    const seenSignal = new Map(); // dedupe key -> tick ms, mirrors orchestrator's 5-min bucket

    for (let t = dateFromMs; t <= dateToMs; t += TICK_MS) {
      // Advance per-symbol candle pointers to "now" (no lookahead past t)
      for (const symbol of symbols) {
        const d = data[symbol];
        while (d.ptr15m < d.klines15m.length && d.klines15m[d.ptr15m].closeTime <= t) d.ptr15m++;
        while (d.ptr1h < d.klines1h.length && d.klines1h[d.ptr1h].closeTime <= t) d.ptr1h++;
      }

      // 1) Check exits for currently open positions using this tick's candle OHLC
      for (let i = openPositions.length - 1; i >= 0; i--) {
        const pos = openPositions[i];
        const d = data[pos.symbol];
        const idx = d.ptr15m - 1;
        if (idx < 0) continue;
        const candle = d.klines15m[idx];
        if (candle.closeTime <= pos.lastCheckedMs) continue;
        pos.lastCheckedMs = candle.closeTime;

        const maxHoldHit = strat.max_hold_ms > 0 && (candle.closeTime - pos.openedAtMs) >= strat.max_hold_ms;
        const slHit = pos.direction === 'LONG' ? candle.low <= pos.slPrice : candle.high >= pos.slPrice;
        const tpHit = pos.direction === 'LONG' ? candle.high >= pos.tpPrice : candle.low <= pos.tpPrice;

        let exitReason = null, exitPriceRaw = null;
        if (maxHoldHit) { exitReason = 'MAX_HOLD'; exitPriceRaw = candle.close; }
        else if (slHit) { exitReason = 'SL'; exitPriceRaw = pos.slPrice; }
        else if (tpHit) { exitReason = 'TP'; exitPriceRaw = pos.tpPrice; }
        if (!exitReason) continue;

        const exitPrice = applySlippage(exitPriceRaw, pos.direction, 'exit', slippagePercent);
        const pnlPercent = pricePctFor(pos.direction, pos.entryPrice, exitPrice) * pos.leverage;
        const exitFeeUsdt = pos.entryUsdt * pos.leverage * (feePercent / 100);
        const pnlUsdt = pos.entryUsdt * (pnlPercent / 100) - pos.entryFeeUsdt - exitFeeUsdt;

        await closeBacktestPosition(pos.id, {
          exitPrice, exitReason, pnlPercent, pnlUsdt, feeUsdt: exitFeeUsdt, closedAtMs: candle.closeTime,
        });

        balance.availableBalance += pos.entryUsdt + pnlUsdt;
        balance.marginUsed -= pos.entryUsdt;
        recordClose(balance, pnlUsdt, candle.closeTime);
        openPositions.splice(i, 1);
      }

      // 2) Look for new entries across symbols
      for (const symbol of symbols) {
        const d = data[symbol];
        if (d.ptr15m < WARMUP_15M_CANDLES || d.ptr1h < WARMUP_1H_CANDLES) continue;
        if (openPositions.some(p => p.symbol === symbol)) continue; // one open position per symbol
        if (openPositions.length >= (strat.max_open_positions || 3)) continue;

        const window15m = d.klines15m.slice(Math.max(0, d.ptr15m - KLINE_WINDOW), d.ptr15m);
        const window1h = d.klines1h.slice(Math.max(0, d.ptr1h - KLINE_WINDOW), d.ptr1h);

        const fundingRate = fundingRateAt(d.funding, t);
        const allSignals = runIndicators(window1h, window15m, fundingRate, strat);
        const triggered = allSignals.filter(s => s.type !== 'extreme_ob_watch' && allowedSignals.includes(s.type));
        if (triggered.length === 0) continue;

        for (const signal of triggered) {
          const dedupeKey = `${symbol}:${signal.type}:${Math.floor(t / (5 * 60_000))}`;
          if (seenSignal.has(dedupeKey)) continue;
          seenSignal.set(dedupeKey, t);

          const rawSignal = {
            symbol, signalType: signal.type, direction: signal.direction, signalMeta: signal.meta,
            ticker: synthesizeTicker24h(window1h),
            klines1h: window1h, klines15m: window15m,
            fundingRate, openInterest: null, detectedAt: t,
          };

          const candidate = await buildCandidate(rawSignal, strat);
          candidate.filters = await filterCandidate(candidate, strat);
          if (!candidate.filters.passed) continue;

          // Rule-based auto-approve: backtest v1 does not call the live LLM screener
          const tpPercent = candidate.tpPercentOverride ?? strat.tp_percent ?? 2;
          const slPercent = candidate.slPercentOverride ?? strat.sl_percent ?? -1.5;
          const entryUsdt = candidate.entryUsdt;
          if (balance.availableBalance < entryUsdt) continue;

          const entryPriceRaw = candidate.metrics.markPrice;
          const entryPrice = applySlippage(entryPriceRaw, candidate.direction, 'entry', slippagePercent);
          const { tpPrice, slPrice } = tpSlPrices(candidate.direction, entryPrice, tpPercent, slPercent);
          const notional = entryUsdt * candidate.leverage;
          const entryFeeUsdt = notional * (feePercent / 100);
          const slippageUsdt = Math.abs(entryPrice - entryPriceRaw) / entryPriceRaw * notional;

          const posId = await openBacktestPosition(runId, {
            symbol, signalType: signal.type, direction: candidate.direction, leverage: candidate.leverage,
            entryPrice, entryUsdt, tpPercent, slPercent, feeUsdt: entryFeeUsdt, slippageUsdt,
            openedAtMs: t, candidateSnapshot: candidate,
          });

          balance.availableBalance -= entryUsdt;
          balance.marginUsed += entryUsdt;

          openPositions.push({
            id: posId, symbol, direction: candidate.direction, leverage: candidate.leverage,
            entryPrice, entryUsdt, tpPrice, slPrice, openedAtMs: t, lastCheckedMs: 0, entryFeeUsdt,
          });

          break; // at most one new position per symbol per tick
        }
      }
    }

    // Flush any positions still open at the end of the range, mark-to-last-close
    for (const pos of openPositions) {
      const d = data[pos.symbol];
      const lastCandle = d.klines15m[d.ptr15m - 1];
      if (!lastCandle) continue;

      const exitPrice = applySlippage(lastCandle.close, pos.direction, 'exit', slippagePercent);
      const pnlPercent = pricePctFor(pos.direction, pos.entryPrice, exitPrice) * pos.leverage;
      const exitFeeUsdt = pos.entryUsdt * pos.leverage * (feePercent / 100);
      const pnlUsdt = pos.entryUsdt * (pnlPercent / 100) - pos.entryFeeUsdt - exitFeeUsdt;

      await closeBacktestPosition(pos.id, {
        exitPrice, exitReason: 'RUN_END', pnlPercent, pnlUsdt, feeUsdt: exitFeeUsdt, closedAtMs: lastCandle.closeTime,
      });
      recordClose(balance, pnlUsdt, lastCandle.closeTime);
    }

    await saveBacktestBalance(runId, balance);
    await finishBacktestRun(runId, 'completed');
    console.log(`[backtest] run #${runId} completed | trades=${balance.totalTrades} | final balance=${balance.balanceUsdt.toFixed(2)} USDT`);
    return runId;
  } catch (err) {
    await finishBacktestRun(runId, 'failed', err.message).catch(() => {});
    console.error(`[backtest] run #${runId} failed:`, err.message);
    throw err;
  }
}
