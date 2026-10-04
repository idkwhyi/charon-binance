import { fetchKlinesRange, fetchFundingRateHistory } from '../enrichment/binance.js';
import { strategyById } from '../db/settings.js';
import { buildCandidate, filterCandidate } from '../pipeline/candidateBuilder.js';
import { runIndicators } from '../signals/indicators.js';
import { getKlinesCached, DEFAULT_CACHE_DIR } from './klineStore.js';
import { planEntry } from '../pipeline/entryPlan.js';
import { seenSignals, checkAndMarkSeen, markDetectorOutcome } from '../pipeline/dedup.js';
import { portfolioBlock, pickCycleEntry } from '../pipeline/portfolioGates.js';
import { utcDayStartMs, dailyLossStatus } from '../pipeline/riskControls.js';
import { findGaps, INTERVAL_MS } from '../signals/klineCache.js';
import { SIGNAL_TYPE_REJECT } from '../signals/extremeOB.js';
import { applySlippage, evaluateExit, settleExit } from '../execution/simulation.js';
import {
  SIM_SLIPPAGE_PERCENT, SIM_TAKER_FEE_PERCENT, RISK_PERCENT_PER_TRADE, MAX_MARGIN_PERCENT_PER_TRADE,
  DAILY_LOSS_LIMIT_PERCENT, MAX_SAME_DIRECTION_POSITIONS,
} from '../config.js';
import {
  createBacktestRun, finishBacktestRun, openBacktestPosition,
  closeBacktestPosition, saveBacktestBalance, saveBacktestSignalOutcomes,
} from '../db/backtest.js';
import { aggregateOutcomes } from './report.js';

const TICK_MS = 15 * 60_000;

/** Signal outcomes of the most recent run (in-memory; for tests and the report). */
export let lastRunRejections = [];
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

/** Index of the first candle with openTime >= tMs (candles sorted by openTime). */
export function lowerBoundByOpenTime(candles, tMs) {
  let lo = 0, hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].openTime < tMs) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** 1m candles that opened in [fromMs, toMs). */
export function candlesBetween(candles, fromMs, toMs) {
  return candles.slice(lowerBoundByOpenTime(candles, fromMs), lowerBoundByOpenTime(candles, toMs));
}

/** Close of the latest 1m candle that closed before tMs (stand-in for mark price). */
export function lastClosedPrice(candles, tMs) {
  for (let i = lowerBoundByOpenTime(candles, tMs) - 1; i >= 0; i--) {
    if (candles[i].closeTime < tMs) return candles[i].close;
  }
  return null;
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
 * Replay historical klines through the same signal/filter pipeline the live
 * bot uses (runIndicators -> buildCandidate -> filterCandidate) and the SAME
 * fill model as dry-run (src/execution/simulation.js):
 * - entry re-planned with planEntry() at the slipped price (R:R, SL distance,
 *   liquidation, risk sizing)
 * - SL/TP/liq-guard on closed 1m candle high/low, SL first on a double touch,
 *   SL fills at the open on a gap, TP never better than its level
 * - MAX_HOLD at the last closed 1m close; slippage + taker fee per side
 *   from SIM_SLIPPAGE_PERCENT / SIM_TAKER_FEE_PERCENT
 *
 * Portfolio gates are the live ones (portfolioGates.js): daily loss limit,
 * max open positions per strategy, then at most ONE entry per 15m cycle
 * picked by the shared selector, skipping open symbols and capped directions.
 *
 * Known simplifications vs. dry-run (documented, not silently assumed):
 * - Decisions are rule-based only; the LLM screener is not invoked.
 * - Entry "mark price" is the last closed 15m close at each 15m tick.
 * - /pause and agent_enabled are not replayed.
 * - No trailing-stop simulation.
 */
export async function runBacktest(opts) {
  const {
    label = `backtest-${Date.now()}`,
    strategyId,
    symbols,
    dateFromMs,
    dateToMs,
    startingBalance = 1000,
    cacheDir = DEFAULT_CACHE_DIR,
  } = opts;
  const costs = { slippagePercent: SIM_SLIPPAGE_PERCENT, feePercent: SIM_TAKER_FEE_PERCENT };

  const strat = await strategyById(strategyId);
  const allowedSignals = (strat.signal_types || '').split(',').map(s => s.trim());

  const runId = await createBacktestRun({
    label, strategyId, symbols, dateFromMs, dateToMs,
    startingBalance, feePercent: costs.feePercent, slippagePercent: costs.slippagePercent, params: {},
  });

  console.log(`[backtest] run #${runId} started: "${label}" | ${symbols.join(',')} | strategy=${strategyId} | slippage=${costs.slippagePercent}% fee=${costs.feePercent}%/side`);

  try {
    const warmupMs1h = WARMUP_1H_CANDLES * 60 * 60_000;
    const warmupMs15m = WARMUP_15M_CANDLES * 15 * 60_000;
    const exitDataEndMs = dateToMs + (Number(strat.max_hold_ms) || 0) + TICK_MS;

    const data = {};
    for (const symbol of symbols) {
      console.log(`[backtest] fetching historical data for ${symbol} (1h, 15m, 1m, funding)...`);
      // Candles come from the local cache; only days not cached yet are downloaded
      const cached = (interval, from, to) =>
        getKlinesCached(symbol, interval, from, to, { dir: cacheDir, fetchRange: fetchKlinesRange }).then(r => {
          if (r.downloadedDays) console.log(`[backtest]   ${symbol} ${interval}: ${r.cachedDays} day(s) cached, ${r.downloadedDays} downloaded`);
          return r.candles;
        });
      const [klines1h, klines15m, klines1m, funding] = await Promise.all([
        cached('1h', dateFromMs - warmupMs1h, dateToMs),
        cached('15m', dateFromMs - warmupMs15m, dateToMs),
        cached('1m', dateFromMs, Math.min(exitDataEndMs, Date.now())),
        fetchFundingRateHistory(symbol, dateFromMs - warmupMs1h, dateToMs).catch(() => []),
      ]);
      data[symbol] = { klines1h, klines15m, klines1m, funding, ptr1h: 0, ptr15m: 0 };
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
    const closes = [];      // { closedAtMs, pnlUsdt } — for the daily loss limit
    const rejections = [];  // { symbol, direction, stage, outcome, reasonCode } — same codes as signal_events
    const reject = (src, stage, reasonCode, outcome = 'rejected') =>
      rejections.push({ symbol: src.symbol, direction: src.direction ?? null, stage, outcome, reasonCode });
    seenSignals.clear(); // shared dedup store, driven by simulated time

    const closePos = async (pos, i, trigger, closedAtMs) => {
      const s = settleExit(pos, trigger, costs);
      await closeBacktestPosition(pos.id, {
        exitPrice: s.exitPrice, exitReason: s.exitReason, pnlPercent: s.pnlPercent, pnlUsdt: s.pnlUsdt,
        feeUsdt: s.exitFeeUsdt, slippageUsdt: Math.abs(s.exitPrice - s.exitPriceRaw) * pos.quantity, closedAtMs, pnlR: s.pnlR,
      });
      balance.availableBalance += pos.marginUsdt + s.pnlUsdt;
      balance.marginUsed -= pos.marginUsdt;
      recordClose(balance, s.pnlUsdt, closedAtMs);
      closes.push({ closedAtMs, pnlUsdt: s.pnlUsdt });
      openPositions.splice(i, 1);
    };

    for (let t = dateFromMs; t <= dateToMs; t += TICK_MS) {
      // Advance per-symbol candle pointers to "now" (no lookahead past t)
      for (const symbol of symbols) {
        const d = data[symbol];
        while (d.ptr15m < d.klines15m.length && d.klines15m[d.ptr15m].closeTime <= t) d.ptr15m++;
        while (d.ptr1h < d.klines1h.length && d.klines1h[d.ptr1h].closeTime <= t) d.ptr1h++;
      }

      // 1) Exits: same evaluation as the dry-run monitor, on 1m candles closed before t
      for (let i = openPositions.length - 1; i >= 0; i--) {
        const pos = openPositions[i];
        const k1m = data[pos.symbol].klines1m;
        const window = candlesBetween(k1m, Math.max(pos.openedAtMs, pos.lastCheckedMs + 1), t);
        const maxHoldMs = Number(strat.max_hold_ms) || 0;
        const holdEndMs = maxHoldMs > 0 ? pos.openedAtMs + maxHoldMs : Infinity;
        const { trigger, lastCheckedMs } = evaluateExit(pos, window, {
          nowMs: t, maxHoldMs, maxHoldPrice: lastClosedPrice(k1m, Math.min(t, holdEndMs)),
        });
        pos.lastCheckedMs = lastCheckedMs;
        if (trigger) await closePos(pos, i, trigger, trigger.candle?.closeTime ?? Math.min(t, holdEndMs));
      }

      // 2) Collect this cycle's signals across symbols (as the live scanner does)
      const cycleSignals = [];
      for (const symbol of symbols) {
        const d = data[symbol];
        if (d.ptr15m < WARMUP_15M_CANDLES || d.ptr1h < WARMUP_1H_CANDLES) continue;

        const window15m = d.klines15m.slice(Math.max(0, d.ptr15m - KLINE_WINDOW), d.ptr15m);
        const window1h = d.klines1h.slice(Math.max(0, d.ptr1h - KLINE_WINDOW), d.ptr1h);
        if (findGaps(window15m, INTERVAL_MS['15m'], t).length || findGaps(window1h, INTERVAL_MS['1h'], t).length) {
          reject({ symbol }, 'data', 'DATA_GAP');
          continue;
        }

        const fundingRate = fundingRateAt(d.funding, t);
        const logDetector = allowedSignals.includes('extreme_ob'); // same condition as the live scanner
        for (const signal of runIndicators(window1h, window15m, fundingRate, strat)) {
          if (!logDetector && (signal.type === SIGNAL_TYPE_REJECT || signal.type === 'extreme_ob_watch')) continue;
          if (signal.type === SIGNAL_TYPE_REJECT) {
            markDetectorOutcome(symbol, signal, window15m, t);
            reject({ symbol, direction: signal.direction }, 'detector', signal.meta.reasonCode);
          } else if (signal.type === 'extreme_ob_watch') {
            reject({ symbol, direction: signal.direction }, 'detector',
              signal.meta.waitingFor === 'price_in_ob_zone' ? 'not_in_ob_zone' : 'confirmation_score', 'watch');
          } else if (allowedSignals.includes(signal.type)) {
            cycleSignals.push({
              symbol, signalType: signal.type, direction: signal.direction, signalMeta: signal.meta,
              ticker: synthesizeTicker24h(window1h),
              klines1h: window1h, klines15m: window15m,
              fundingRate, openInterest: null, detectedAt: t,
            });
          }
        }
      }
      if (cycleSignals.length === 0) continue;

      // 3) Portfolio gates — the same pure functions the live orchestrator uses
      const realizedTodayUsdt = closes.filter(c => c.closedAtMs >= utcDayStartMs(t)).reduce((n, c) => n + c.pnlUsdt, 0);
      const block = portfolioBlock({
        daily: dailyLossStatus({ currentBalanceUsdt: balance.balanceUsdt, realizedTodayUsdt, limitPercent: DAILY_LOSS_LIMIT_PERCENT }),
        dailyLimitPercent: DAILY_LOSS_LIMIT_PERCENT,
        openCount: openPositions.length,
        maxOpenPositions: strat.max_open_positions || 3,
      });
      if (block) {
        for (const raw of cycleSignals) reject(raw, 'pipeline', block.code);
        continue;
      }

      const prepared = [];
      for (const rawSignal of cycleSignals) {
        if (checkAndMarkSeen(rawSignal, t)) { reject(rawSignal, 'pipeline', 'dedup'); continue; }
        const candidate = await buildCandidate(rawSignal, strat, balance.availableBalance);
        candidate.filters = await filterCandidate(candidate, strat);
        if (!candidate.filters.passed) { reject(rawSignal, 'pipeline', 'filter_failed'); continue; }
        prepared.push(candidate);
      }
      if (prepared.length === 0) continue;

      const { selected, rejections: notPicked } = pickCycleEntry(prepared, openPositions, MAX_SAME_DIRECTION_POSITIONS);
      for (const r of notPicked) reject(r.candidate, 'pipeline', r.reasonCode);
      if (!selected) continue;

      // 4) Re-plan at the (slipped) entry price, exactly like dry-run's planAtActualPrice
      const window15m = selected.klineSnapshot?.last5_15m || [];
      const entryMarkPrice = window15m[window15m.length - 1]?.close ?? selected.metrics.markPrice;
      const meta = selected.signals?.meta || {};
      const plan = planEntry({
        direction: selected.direction,
        entryPrice: applySlippage(entryMarkPrice, selected.direction, 'entry', costs.slippagePercent),
        stopLoss: meta.stopLoss,
        takeProfit: meta.takeProfit,
        fallbackTpPercent: selected.tpPercentOverride ?? strat.tp_percent ?? 2,
        fallbackSlPercent: selected.slPercentOverride ?? strat.sl_percent ?? -1.5,
        availableBalanceUsdt: balance.availableBalance,
        riskPercent: RISK_PERCENT_PER_TRADE,
        leverage: selected.leverage,
        maxMarginPercent: MAX_MARGIN_PERCENT_PER_TRADE,
      });
      if (!plan.ok) { reject(selected, 'entry', plan.code || 'rejected_at_entry'); continue; }
      if (balance.availableBalance < plan.entryUsdt) { reject(selected, 'entry', 'open_failed'); continue; }

      const quantity = plan.notionalUsdt / plan.entryPrice;
      const entryFeeUsdt = plan.entryPrice * quantity * (costs.feePercent / 100);
      const posId = await openBacktestPosition(runId, {
        symbol: selected.symbol, signalType: selected.signalType, direction: selected.direction, leverage: selected.leverage,
        entryPrice: plan.entryPrice, entryUsdt: plan.entryUsdt, tpPercent: plan.tpPercent, slPercent: plan.slPercent,
        feeUsdt: entryFeeUsdt, slippageUsdt: Math.abs(plan.entryPrice - entryMarkPrice) * quantity,
        openedAtMs: t, candidateSnapshot: selected, riskUsdt: plan.riskUsdt,
      });
      reject(selected, 'entry', 'opened', 'executed');

      balance.availableBalance -= plan.entryUsdt;
      balance.marginUsed += plan.entryUsdt;

      openPositions.push({
        id: posId, symbol: selected.symbol, direction: selected.direction,
        entryPrice: plan.entryPrice, entryMarkPrice, quantity, marginUsdt: plan.entryUsdt, riskUsdt: plan.riskUsdt,
        stopLoss: plan.stopLoss, takeProfit: plan.takeProfit, liqPrice: plan.liqPrice,
        openedAtMs: t, lastCheckedMs: 0,
      });
    }

    // Positions still open at the end: keep evaluating on the 1m data fetched
    // past dateTo (covers max hold), else close at the last available 1m close.
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i];
      const k1m = data[pos.symbol].klines1m;
      const endMs = (k1m[k1m.length - 1]?.closeTime ?? dateToMs) + 1;
      const maxHoldMs = Number(strat.max_hold_ms) || 0;
      const holdEndMs = maxHoldMs > 0 ? pos.openedAtMs + maxHoldMs : Infinity;
      const { trigger } = evaluateExit(pos, candlesBetween(k1m, Math.max(pos.openedAtMs, pos.lastCheckedMs + 1), endMs), {
        nowMs: endMs, maxHoldMs, maxHoldPrice: lastClosedPrice(k1m, Math.min(endMs, holdEndMs)),
      });
      if (trigger) {
        await closePos(pos, i, trigger, trigger.candle?.closeTime ?? holdEndMs);
        continue;
      }
      const lastPrice = lastClosedPrice(k1m, endMs);
      if (lastPrice !== null) await closePos(pos, i, { exitReason: 'RUN_END', exitPriceRaw: lastPrice }, endMs);
    }

    await saveBacktestBalance(runId, balance);
    await saveBacktestSignalOutcomes(runId, aggregateOutcomes(rejections));
    await finishBacktestRun(runId, 'completed');
    lastRunRejections = rejections;
    console.log(`[backtest] run #${runId} completed | trades=${balance.totalTrades} | final balance=${balance.balanceUsdt.toFixed(2)} USDT`);
    return runId;
  } catch (err) {
    await finishBacktestRun(runId, 'failed', err.message).catch(() => {});
    console.error(`[backtest] run #${runId} failed:`, err.message);
    throw err;
  }
}
