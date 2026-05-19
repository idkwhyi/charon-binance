/**
 * Fibonacci Retracement Calculator
 *
 * For UPTREND (LONG setup):
 *   Swing Low → Swing High
 *   Retracement levels measured from High downward
 *   Entry zone: 0.705 – 0.79 (deep retracement, near OB)
 *
 * For DOWNTREND (SHORT setup):
 *   Swing High → Swing Low
 *   Retracement levels measured from Low upward
 *   Entry zone: 0.705 – 0.79 (deep retracement, near OB)
 */

export const FIB_LEVELS = [0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 0.886];

/**
 * Calculate Fibonacci retracement price levels.
 *
 * @param {number} swingLow
 * @param {number} swingHigh
 * @param {'LONG'|'SHORT'} direction
 * @returns {{ levels: Record<string, number>, entryZoneLow: number, entryZoneHigh: number }}
 */
export function calcFibLevels(swingLow, swingHigh, direction) {
  const range = swingHigh - swingLow;
  const levels = {};

  for (const fib of FIB_LEVELS) {
    if (direction === 'LONG') {
      // Retracement from high downward
      levels[fib] = swingHigh - range * fib;
    } else {
      // Retracement from low upward
      levels[fib] = swingLow + range * fib;
    }
  }

  // Entry zone: between 70.5% and 79% retracement (deep OB zone)
  const entryZoneLow  = direction === 'LONG' ? levels[0.786] : levels[0.705];
  const entryZoneHigh = direction === 'LONG' ? levels[0.705] : levels[0.786];

  return { levels, entryZoneLow, entryZoneHigh };
}

/**
 * Check if current price is within the Fibonacci entry zone (79% area).
 *
 * @param {number} currentPrice
 * @param {number} swingLow
 * @param {number} swingHigh
 * @param {'LONG'|'SHORT'} direction
 * @param {number} tolerance - extra % buffer around zone (default 0.5%)
 * @returns {{ inZone: boolean, fib79Price: number, entryZoneLow: number, entryZoneHigh: number, levels: object }}
 */
export function isPriceInFibZone(currentPrice, swingLow, swingHigh, direction, tolerance = 0.005) {
  const { levels, entryZoneLow, entryZoneHigh } = calcFibLevels(swingLow, swingHigh, direction);

  const buffer = (swingHigh - swingLow) * tolerance;
  const zoneLow  = entryZoneLow  - buffer;
  const zoneHigh = entryZoneHigh + buffer;

  const inZone = currentPrice >= zoneLow && currentPrice <= zoneHigh;

  return {
    inZone,
    fib79Price: levels[0.786],
    fib705Price: levels[0.705],
    entryZoneLow,
    entryZoneHigh,
    levels,
  };
}
