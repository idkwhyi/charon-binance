import { calcRSI, calcEMA } from '../utils.js';
import { detectExtremeOB } from './extremeOB.js';

/**
 * Detect volume spike: latest kline volume vs average of previous N klines.
 * @param {Array} klines - sorted oldest first
 * @param {number} ratio - spike threshold multiplier (e.g. 3 = 3× avg)
 * @param {number} lookback - number of periods for average
 * @returns {{ detected: boolean, ratio: number, direction: 'LONG'|'SHORT' }}
 */
export function detectVolumeSpike(klines, ratio = 3, lookback = 20) {
  if (klines.length < lookback + 1) return { detected: false, ratio: 0, direction: null };
  const recent = klines[klines.length - 1];
  const prev = klines.slice(klines.length - 1 - lookback, klines.length - 1);
  const avgVol = prev.reduce((s, k) => s + k.volume, 0) / prev.length;
  if (avgVol <= 0) return { detected: false, ratio: 0, direction: null };
  const spikeRatio = recent.volume / avgVol;
  const detected = spikeRatio >= ratio;
  // Direction from candle body
  const direction = recent.close >= recent.open ? 'LONG' : 'SHORT';
  return { detected, ratio: spikeRatio, direction };
}

/**
 * Detect RSI extremes.
 * @returns {{ detected: boolean, rsi: number, signal: string, direction: 'LONG'|'SHORT'|null }}
 */
export function detectRsiSignal(klines, period = 14, oversold = 30, overbought = 70) {
  const closes = klines.map(k => k.close);
  const rsi = calcRSI(closes, period);
  if (rsi === null) return { detected: false, rsi: null, signal: null, direction: null };
  if (rsi < oversold) return { detected: true, rsi, signal: 'rsi_oversold', direction: 'LONG' };
  if (rsi > overbought) return { detected: true, rsi, signal: 'rsi_overbought', direction: 'SHORT' };
  return { detected: false, rsi, signal: null, direction: null };
}

/**
 * Detect EMA crossover (EMA9 vs EMA21).
 * @returns {{ detected: boolean, signal: string, direction: 'LONG'|'SHORT'|null, ema9: number, ema21: number }}
 */
export function detectEmaCross(klines, fastPeriod = 9, slowPeriod = 21) {
  if (klines.length < slowPeriod + 2) return { detected: false, signal: null, direction: null, ema9: null, ema21: null };
  const closes = klines.map(k => k.close);

  // Previous bar EMAs
  const prevCloses = closes.slice(0, -1);
  const prevEmaFast = calcEMA(prevCloses, fastPeriod);
  const prevEmaSlow = calcEMA(prevCloses, slowPeriod);

  // Current bar EMAs
  const currEmaFast = calcEMA(closes, fastPeriod);
  const currEmaSlow = calcEMA(closes, slowPeriod);

  if (!prevEmaFast || !prevEmaSlow || !currEmaFast || !currEmaSlow) {
    return { detected: false, signal: null, direction: null, ema9: currEmaFast, ema21: currEmaSlow };
  }

  const bullCross = prevEmaFast <= prevEmaSlow && currEmaFast > currEmaSlow;
  const bearCross = prevEmaFast >= prevEmaSlow && currEmaFast < currEmaSlow;

  if (bullCross) return { detected: true, signal: 'ema_cross_bull', direction: 'LONG', ema9: currEmaFast, ema21: currEmaSlow };
  if (bearCross) return { detected: true, signal: 'ema_cross_bear', direction: 'SHORT', ema9: currEmaFast, ema21: currEmaSlow };
  return { detected: false, signal: null, direction: null, ema9: currEmaFast, ema21: currEmaSlow };
}

/**
 * Detect extreme funding rate.
 * Positive funding (longs pay) = crowded long → SHORT bias.
 * Negative funding (shorts pay) = crowded short → LONG bias.
 * @param {number} fundingRate - as decimal (e.g. 0.001 = 0.1%)
 * @returns {{ detected: boolean, signal: string, direction: 'LONG'|'SHORT'|null, fundingRate: number }}
 */
export function detectFundingExtreme(fundingRate, longThreshold = 0.001, shortThreshold = -0.0005) {
  const fr = Number(fundingRate);
  if (!Number.isFinite(fr)) return { detected: false, signal: null, direction: null, fundingRate: fr };
  if (fr >= longThreshold) {
    // Crowded long → SHORT
    return { detected: true, signal: 'funding_extreme', direction: 'SHORT', fundingRate: fr };
  }
  if (fr <= shortThreshold) {
    // Crowded short → LONG
    return { detected: true, signal: 'funding_extreme', direction: 'LONG', fundingRate: fr };
  }
  return { detected: false, signal: null, direction: null, fundingRate: fr };
}

/**
 * Run all indicator checks and return triggered signals.
 * @param {Array} klines - primary timeframe klines (5m)
 * @param {number|null} fundingRate
 * @param {object} stratConfig
 * @param {Array} [klines15m] - 15m klines for market structure (used by extreme_ob)
 */
export function runIndicators(klines, fundingRate, stratConfig, klines15m = null) {
  const signals = [];

  const volSpike = detectVolumeSpike(klines, stratConfig.min_volume_spike_ratio || 3);
  if (volSpike.detected) {
    signals.push({ type: 'volume_spike', direction: volSpike.direction, meta: { ratio: volSpike.ratio } });
  }

  const rsi = detectRsiSignal(klines);
  if (rsi.detected) {
    signals.push({ type: rsi.signal, direction: rsi.direction, meta: { rsi: rsi.rsi } });
  }

  const ema = detectEmaCross(klines);
  if (ema.detected) {
    signals.push({ type: ema.signal, direction: ema.direction, meta: { ema9: ema.ema9, ema21: ema.ema21 } });
  }

  if (fundingRate !== null) {
    const funding = detectFundingExtreme(fundingRate);
    if (funding.detected) {
      signals.push({ type: 'funding_extreme', direction: funding.direction, meta: { fundingRate: funding.fundingRate } });
    }
  }

  // Extreme Order Block: requires both 5m and 15m klines
  if (klines15m && klines15m.length >= 20) {
    const obSignals = detectExtremeOB(klines, klines15m, fundingRate);
    signals.push(...obSignals);
  }

  return signals;
}
