/**
 * Entry Confirmation Module
 * 
 * Implements ICT-style entry confirmation for Order Block trades:
 * 1. Wait for price to retrace to OB zone (not direct entry)
 * 2. Look for Market Structure Shift (MSS) on lower timeframe (15m)
 * 3. Confirm with rejection candle pattern
 * 4. Enter at optimal level (50% of OB zone)
 * 
 * This ensures we're not entering too early and waiting for proper
 * price action confirmation before taking the trade.
 */

/**
 * Detect Market Structure Shift (MSS) on lower timeframe.
 * 
 * For LONG: Price breaks above recent swing high (bullish MSS)
 * For SHORT: Price breaks below recent swing low (bearish MSS)
 * 
 * @param {Array} klines - 15m klines, sorted oldest first
 * @param {'LONG'|'SHORT'} direction
 * @param {number} lookback - candles to look back for swing points
 * @returns {{ detected: boolean, mssPrice: number|null, mssTime: number|null }}
 */
export function detectMarketStructureShift(klines, direction, lookback = 10) {
  if (!klines || klines.length < lookback + 2) {
    return { detected: false, mssPrice: null, mssTime: null };
  }

  // Get recent candles for analysis
  const recentKlines = klines.slice(-lookback - 1);
  const lastCandle = klines[klines.length - 1];

  if (direction === 'LONG') {
    // Find recent swing high (highest high in lookback period, excluding last candle)
    const swingHigh = Math.max(...recentKlines.slice(0, -1).map(k => k.high));
    
    // MSS detected if last candle closes above swing high
    const detected = lastCandle.close > swingHigh;
    
    return {
      detected,
      mssPrice: detected ? swingHigh : null,
      mssTime: detected ? lastCandle.closeTime : null,
      swingLevel: swingHigh,
    };
  } else {
    // Find recent swing low (lowest low in lookback period, excluding last candle)
    const swingLow = Math.min(...recentKlines.slice(0, -1).map(k => k.low));
    
    // MSS detected if last candle closes below swing low
    const detected = lastCandle.close < swingLow;
    
    return {
      detected,
      mssPrice: detected ? swingLow : null,
      mssTime: detected ? lastCandle.closeTime : null,
      swingLevel: swingLow,
    };
  }
}

/**
 * Detect rejection candle pattern in OB zone.
 * 
 * For LONG: Bullish candle with long lower wick (rejection of lower prices)
 * For SHORT: Bearish candle with long upper wick (rejection of higher prices)
 * 
 * @param {object} candle - Latest candle
 * @param {'LONG'|'SHORT'} direction
 * @param {number} minWickRatio - minimum wick to body ratio (default 1.5)
 * @returns {{ detected: boolean, wickSize: number, bodySize: number, ratio: number }}
 */
export function detectRejectionCandle(candle, direction, minWickRatio = 1.5) {
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  
  if (range === 0 || body === 0) {
    return { detected: false, wickSize: 0, bodySize: 0, ratio: 0 };
  }

  if (direction === 'LONG') {
    // Bullish rejection: long lower wick, bullish close
    const isBullish = candle.close > candle.open;
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const ratio = lowerWick / body;
    
    const detected = isBullish && ratio >= minWickRatio;
    
    return {
      detected,
      wickSize: lowerWick,
      bodySize: body,
      ratio: parseFloat(ratio.toFixed(2)),
      wickPercent: parseFloat((lowerWick / range * 100).toFixed(2)),
    };
  } else {
    // Bearish rejection: long upper wick, bearish close
    const isBearish = candle.close < candle.open;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const ratio = upperWick / body;
    
    const detected = isBearish && ratio >= minWickRatio;
    
    return {
      detected,
      wickSize: upperWick,
      bodySize: body,
      ratio: parseFloat(ratio.toFixed(2)),
      wickPercent: parseFloat((upperWick / range * 100).toFixed(2)),
    };
  }
}

/**
 * Check if price is in optimal entry zone (around 50% of OB).
 * 
 * ICT methodology suggests entering at 50% of OB zone for optimal
 * risk-reward and to ensure we're in the "sweet spot" of the zone.
 * 
 * @param {number} currentPrice
 * @param {object} ob - Order block object with obHigh and obLow
 * @param {number} tolerance - tolerance around 50% (default 0.25 = 25% to 75%)
 * @returns {{ inOptimalZone: boolean, obMid: number, distanceFromMid: number, percentInZone: number }}
 */
export function isInOptimalEntryZone(currentPrice, ob, tolerance = 0.25) {
  const obMid = (ob.obHigh + ob.obLow) / 2;
  const obRange = ob.obHigh - ob.obLow;
  
  if (obRange === 0) {
    return { inOptimalZone: false, obMid, distanceFromMid: 0, percentInZone: 0 };
  }
  
  // Calculate how far price is from OB mid (as percentage of OB range)
  const distanceFromMid = Math.abs(currentPrice - obMid);
  const percentFromMid = distanceFromMid / obRange;
  
  // In optimal zone if within tolerance of 50% mark
  const inOptimalZone = percentFromMid <= tolerance;
  
  // Calculate where in the OB zone we are (0% = obLow, 100% = obHigh)
  const percentInZone = ((currentPrice - ob.obLow) / obRange) * 100;
  
  return {
    inOptimalZone,
    obMid,
    distanceFromMid: parseFloat(distanceFromMid.toFixed(8)),
    percentFromMid: parseFloat((percentFromMid * 100).toFixed(2)),
    percentInZone: parseFloat(percentInZone.toFixed(2)),
  };
}

/**
 * Check if price has properly retested the OB zone.
 * 
 * A proper retest means:
 * 1. Price was outside the OB zone
 * 2. Price moved into the OB zone
 * 3. Price is now reacting (showing rejection or MSS)
 * 
 * @param {Array} klines - Recent 15m klines
 * @param {object} ob - Order block object
 * @param {'LONG'|'SHORT'} direction
 * @param {number} lookback - candles to look back
 * @returns {{ retested: boolean, retestCandle: object|null, priceAction: string }}
 */
export function hasRetested(klines, ob, direction, lookback = 5) {
  if (!klines || klines.length < lookback) {
    return { retested: false, retestCandle: null, priceAction: 'insufficient_data' };
  }

  const recentKlines = klines.slice(-lookback);
  const currentPrice = klines[klines.length - 1].close;
  
  // Check if current price is in OB zone
  const inZone = currentPrice >= ob.obLow && currentPrice <= ob.obHigh;
  
  if (!inZone) {
    return { retested: false, retestCandle: null, priceAction: 'not_in_zone' };
  }

  if (direction === 'LONG') {
    // For LONG: Check if price came from above and entered OB zone
    // Look for a candle that was above OB high, then price moved into zone
    let cameFromAbove = false;
    let retestCandle = null;
    
    for (let i = 0; i < recentKlines.length - 1; i++) {
      const candle = recentKlines[i];
      const nextCandle = recentKlines[i + 1];
      
      // Price was above OB, then moved into OB
      if (candle.low > ob.obHigh && nextCandle.low <= ob.obHigh) {
        cameFromAbove = true;
        retestCandle = nextCandle;
        break;
      }
    }
    
    return {
      retested: cameFromAbove,
      retestCandle,
      priceAction: cameFromAbove ? 'retraced_from_above' : 'already_in_zone',
    };
  } else {
    // For SHORT: Check if price came from below and entered OB zone
    let cameFromBelow = false;
    let retestCandle = null;
    
    for (let i = 0; i < recentKlines.length - 1; i++) {
      const candle = recentKlines[i];
      const nextCandle = recentKlines[i + 1];
      
      // Price was below OB, then moved into OB
      if (candle.high < ob.obLow && nextCandle.high >= ob.obLow) {
        cameFromBelow = true;
        retestCandle = nextCandle;
        break;
      }
    }
    
    return {
      retested: cameFromBelow,
      retestCandle,
      priceAction: cameFromBelow ? 'retraced_from_below' : 'already_in_zone',
    };
  }
}

/**
 * Comprehensive entry confirmation check.
 * 
 * Combines all confirmation signals:
 * 1. Price in OB zone (already checked in main logic)
 * 2. Price in optimal entry zone (50% of OB)
 * 3. Market Structure Shift on 15m
 * 4. Rejection candle pattern
 * 5. Proper retest of OB zone
 * 
 * @param {Array} klines15m - 15m klines
 * @param {object} ob - Order block object
 * @param {'LONG'|'SHORT'} direction
 * @param {number} currentPrice
 * @returns {{ confirmed: boolean, signals: object, score: number, reason: string }}
 */
export function confirmEntry(klines15m, ob, direction, currentPrice) {
  const signals = {
    inOptimalZone: false,
    mssDetected: false,
    rejectionCandle: false,
    properRetest: false,
  };
  
  let score = 0;
  const reasons = [];
  
  // 1. Check optimal entry zone (50% of OB) - REQUIRED
  const optimalZone = isInOptimalEntryZone(currentPrice, ob, 0.3); // 30% tolerance
  signals.inOptimalZone = optimalZone.inOptimalZone;
  signals.optimalZoneData = optimalZone;
  
  if (optimalZone.inOptimalZone) {
    score += 3; // High weight
    reasons.push(`in optimal zone (${optimalZone.percentInZone.toFixed(0)}% of OB)`);
  } else {
    reasons.push(`not in optimal zone (${optimalZone.percentInZone.toFixed(0)}% of OB, need 25-75%)`);
  }
  
  // 2. Check Market Structure Shift on 15m - STRONG CONFIRMATION
  const mss = detectMarketStructureShift(klines15m, direction, 10);
  signals.mssDetected = mss.detected;
  signals.mssData = mss;
  
  if (mss.detected) {
    score += 3; // High weight
    reasons.push(`MSS detected (broke ${mss.swingLevel?.toFixed(2)})`);
  } else {
    reasons.push(`no MSS yet (swing level: ${mss.swingLevel?.toFixed(2)})`);
  }
  
  // 3. Check rejection candle - GOOD CONFIRMATION
  const lastCandle = klines15m[klines15m.length - 1];
  const rejection = detectRejectionCandle(lastCandle, direction, 1.5);
  signals.rejectionCandle = rejection.detected;
  signals.rejectionData = rejection;
  
  if (rejection.detected) {
    score += 2; // Medium weight
    reasons.push(`rejection candle (wick:body = ${rejection.ratio}:1)`);
  }
  
  // 4. Check proper retest - NICE TO HAVE
  const retest = hasRetested(klines15m, ob, direction, 5);
  signals.properRetest = retest.retested;
  signals.retestData = retest;
  
  if (retest.retested) {
    score += 1; // Low weight
    reasons.push(`proper retest (${retest.priceAction})`);
  }
  
  // Decision logic:
  // - REQUIRED: In optimal zone (score >= 3)
  // - STRONG: MSS detected (score >= 6)
  // - GOOD: MSS + rejection (score >= 8)
  // - EXCELLENT: All signals (score = 9)
  
  const confirmed = score >= 6; // Need optimal zone + MSS at minimum
  
  return {
    confirmed,
    signals,
    score,
    maxScore: 9,
    reason: reasons.join('; '),
    strength: score >= 8 ? 'excellent' : score >= 6 ? 'strong' : score >= 3 ? 'weak' : 'insufficient',
  };
}

/**
 * Calculate optimal entry price based on OB zone and confirmation.
 * 
 * ICT suggests entering at 50% of OB zone for best risk-reward.
 * If price is already past 50%, use current price.
 * 
 * @param {number} currentPrice
 * @param {object} ob - Order block object
 * @param {'LONG'|'SHORT'} direction
 * @returns {number} - Optimal entry price
 */
export function calculateOptimalEntry(currentPrice, ob, direction) {
  const obMid = (ob.obHigh + ob.obLow) / 2;
  
  if (direction === 'LONG') {
    // For LONG: prefer entry at or below 50% of OB
    // If price is already above 50%, use current price
    return currentPrice <= obMid ? currentPrice : obMid;
  } else {
    // For SHORT: prefer entry at or above 50% of OB
    // If price is already below 50%, use current price
    return currentPrice >= obMid ? currentPrice : obMid;
  }
}
