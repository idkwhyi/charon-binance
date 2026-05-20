import { activeStrategy } from '../db/settings.js';
import { now, firstPositive } from '../utils.js';
import { TRADE_AMOUNT_USDT, MARGIN_TYPE } from '../config.js';

/**
 * Build a structured candidate object from a raw signal event.
 */
export function buildCandidate(signal) {
  const strat = activeStrategy();
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

  return {
    symbol: signal.symbol,
    signalType: signal.signalType,
    direction: signal.direction,
    strategyId: strat.id,
    leverage: strat.leverage,
    marginType: MARGIN_TYPE,
    entryUsdt: TRADE_AMOUNT_USDT,
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
 * Returns { passed: boolean, failures: string[] }
 */
export function filterCandidate(candidate) {
  const strat = activeStrategy();
  const failures = [];

  const { markPrice, volume24hUsdt, openInterestUsdt, fundingRate, lastKlineVolume } = candidate.metrics;

  // Min price (avoid dust)
  if (!markPrice || markPrice <= 0) {
    failures.push('mark price: missing or zero');
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
