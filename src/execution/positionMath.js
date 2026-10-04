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
