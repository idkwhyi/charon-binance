import { activeStrategy } from '../db/settings.js';
import { now, firstPositive } from '../utils.js';
import { MARGIN_TYPE, RISK_PERCENT_PER_TRADE, MAX_MARGIN_PERCENT_PER_TRADE, TRADE_AMOUNT_USDT } from '../config.js';
import { calculatePositionSize } from './positionSizing.js';
import { tradingMode } from '../db/positions.js';
import { fetchFuturesBalance } from '../enrichment/binance.js';
import { getVirtualBalance } from '../db/virtualBalance.js';

/**
 * Resolve the available balance/equity to size this trade against.
 * @param {number|null} balanceOverride - pass the current equity explicitly
 *   (e.g. the backtest runner's running balance) to bypass the live/dry-run lookup.
 */
export async function resolveAvailableBalance(balanceOverride) {
  if (typeof balanceOverride === 'number') return balanceOverride;
  try {
    if (tradingMode() === 'live') {
      const bal = await fetchFuturesBalance();
      return bal.availableBalance;
    }
    const vb = await getVirtualBalance();
    return vb.available_balance;
  } catch (err) {
    console.log(`[candidateBuilder] balance lookup failed, falling back to TRADE_AMOUNT_USDT: ${err.message}`);
    return null;
  }
}

/**
 * Build a structured candidate object from a raw signal event.
 * @param {object} signal
 * @param {object|null} strategyOverride - pass an explicit strategy (e.g. from the
 *   backtest runner) instead of reading the live active_strategy setting.
 * @param {number|null} balanceOverride - pass the current equity explicitly (e.g. the
 *   backtest runner's running balance) instead of fetching live/dry-run balance.
 */
export async function buildCandidate(signal, strategyOverride = null, balanceOverride = null) {
  const strat = strategyOverride || await activeStrategy();
  const ticker = signal.ticker || {};
  const markPrice = firstPositive(ticker.lastPrice, ticker.price, 0);
  const volume24h = firstPositive(ticker.quoteVolume, 0);
  const priceChangePct = Number(ticker.priceChangePercent || 0);
  const highPrice = Number(ticker.highPrice || markPrice);
  const lowPrice = Number(ticker.lowPrice || markPrice);
  const openInterestUsdt = signal.openInterest ? signal.openInterest * markPrice : null;

  const klines15m = signal.klines15m || [];
  const lastKline = klines15m[klines15m.length - 1] || {};

  // For extreme_ob signals, use OB-derived TP/SL if available
  const obMeta = signal.signalType === 'extreme_ob' ? (signal.signalMeta || {}) : {};
  const tpPercent = obMeta.tpPercent ?? strat.tp_percent;
  const slPercent = obMeta.slPercent ?? strat.sl_percent;
  const slDistancePercent = Math.abs(obMeta.slDistancePct ?? slPercent);

  // Risk-based position sizing: risk a fixed % of current balance regardless
  // of leverage; notional (and margin) scale with this trade's actual SL
  // distance. Falls back to the flat TRADE_AMOUNT_USDT margin if the balance
  // lookup fails or sizing is otherwise invalid.
  const availableBalanceUsdt = await resolveAvailableBalance(balanceOverride);
  const sizing = availableBalanceUsdt !== null
    ? calculatePositionSize({
        availableBalanceUsdt,
        riskPercent: RISK_PERCENT_PER_TRADE,
        slDistancePercent,
        leverage: strat.leverage,
        maxMarginPercent: MAX_MARGIN_PERCENT_PER_TRADE,
      })
    : { entryUsdt: TRADE_AMOUNT_USDT, notionalUsdt: TRADE_AMOUNT_USDT * strat.leverage, riskUsdt: null, clamped: false, ok: true, reason: null };

  return {
    symbol: signal.symbol,
    signalType: signal.signalType,
    direction: signal.direction,
    strategyId: strat.id,
    leverage: strat.leverage,
    marginType: MARGIN_TYPE,
    entryUsdt: sizing.entryUsdt,
    riskUsdt: sizing.riskUsdt,
    sizingClamped: sizing.clamped,
    sizingRejected: !sizing.ok,
    sizingReason: sizing.reason,
    // OB-specific trade levels (null for non-OB signals)
    obEntry:     obMeta.entry     ?? null,
    obStopLoss:  obMeta.stopLoss  ?? null,
    obTakeProfit: obMeta.takeProfit ?? null,
    obRR:        obMeta.rrRatio   ?? null,
    // Override TP/SL percent from OB calculation
    tpPercentOverride: obMeta.tpPercent ?? null,
    slPercentOverride: obMeta.slPercent ?? null,
    metrics: {
      markPrice,
      volume24hUsdt: volume24h,
      priceChangePct24h: priceChangePct,
      highPrice24h: highPrice,
      lowPrice24h: lowPrice,
      openInterestUsdt,
      fundingRate: signal.fundingRate,
      lastKlineVolume: lastKline.volume || null,
      lastKlineClose: lastKline.close || null,
    },
    signals: {
      type: signal.signalType,
      direction: signal.direction,
      meta: signal.signalMeta || {},
      strategy: strat.id,
      detectedAt: signal.detectedAt || now(),
    },
    klineSnapshot: {
      last5_1h: (signal.klines1h || []).slice(-5),
      last5_15m: (signal.klines15m || []).slice(-5),
    },
    createdAtMs: now(),
  };
}

/**
 * Apply strategy filters to a candidate.
 * @param {object|null} strategyOverride - see buildCandidate.
 * Returns { passed: boolean, failures: string[] }
 */
export async function filterCandidate(candidate, strategyOverride = null) {
  const strat = strategyOverride || await activeStrategy();
  const failures = [];

  const { markPrice, volume24hUsdt, openInterestUsdt, fundingRate, lastKlineVolume } = candidate.metrics;

  // Min price (avoid dust)
  if (!markPrice || markPrice <= 0) {
    failures.push('mark price: missing or zero');
  }

  // Risk-based sizing rejected (e.g. SL too tight, required margin exceeds cap)
  if (candidate.sizingRejected) {
    failures.push(`position sizing: ${candidate.sizingReason}`);
  }

  // Min 24h volume
  if (strat.min_volume_24h_usdt > 0 && volume24hUsdt < strat.min_volume_24h_usdt) {
    failures.push(`24h volume: $${volume24hUsdt.toFixed(0)} < min $${strat.min_volume_24h_usdt}`);
  }

  // Min open interest
  if (strat.min_open_interest_usdt > 0 && openInterestUsdt !== null && openInterestUsdt < strat.min_open_interest_usdt) {
    failures.push(`open interest: $${openInterestUsdt?.toFixed(0)} < min $${strat.min_open_interest_usdt}`);
  }

  // Signal type gate
  const allowedSignals = (strat.signal_types || '').split(',').map(s => s.trim());
  if (allowedSignals.length > 0 && !allowedSignals.includes(candidate.signalType)) {
    failures.push(`signal type '${candidate.signalType}' not in strategy signal_types`);
  }

  // Funding rate extreme check for funding_fade strategy
  if (strat.id === 'funding_fade' && candidate.signalType !== 'funding_extreme') {
    failures.push('funding_fade strategy requires funding_extreme signal');
  }

  // Extreme OB: require minimum R:R ratio of 1:2
  if (candidate.signalType === 'extreme_ob') {
    const rr = candidate.obRR;
    if (rr !== null && rr < 1.8) {
      failures.push(`extreme_ob R:R ${rr?.toFixed(2)} < minimum 1.8`);
    }
    if (!candidate.signals?.meta?.trend || candidate.signals.meta.trend === 'RANGING') {
      failures.push('extreme_ob requires trending market structure (not RANGING)');
    }
  }

  return { passed: failures.length === 0, failures, strategy: strat.id };
}
