/**
 * Pure position math shared by dry-run and live position creation and exits.
 */

/**
 * @param {object} p
 * @param {number} p.entryUsdt - margin
 * @param {number} p.leverage
 * @param {number} p.entryPrice
 * @returns {{ notionalUsdt: number, quantity: number }}
 */
export function positionSize({ entryUsdt, leverage, entryPrice }) {
  const notionalUsdt = Number(entryUsdt) * Number(leverage || 1);
  const quantity = Number(entryPrice) > 0 ? notionalUsdt / Number(entryPrice) : 0;
  return { notionalUsdt, quantity };
}

/**
 * Quantity to close at exit — must equal the quantity opened.
 * Rows created before the quantity column existed stored margin in
 * notional_usdt, so they are reconstructed from margin x leverage.
 */
export function exitQuantity(position) {
  const stored = Number(position.quantity);
  if (stored > 0) return stored;
  return positionSize({
    entryUsdt: position.entry_usdt,
    leverage: position.leverage,
    entryPrice: position.entry_price,
  }).quantity;
}

/**
 * Rough isolated-margin liquidation estimate (no funding, maintenance margin
 * approximated by liquidating at 90% of the 1/leverage move). Same formula the
 * live executor has always used.
 */
export function estimateLiqPrice(entryPrice, direction, leverage) {
  const move = (1 / Number(leverage || 1)) * 0.9;
  return direction === 'LONG' ? entryPrice * (1 - move) : entryPrice * (1 + move);
}
