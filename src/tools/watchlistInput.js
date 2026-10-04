/**
 * Parse + validate `npm run watchlist:set -- SYM1,SYM2,...` (pure).
 */

export const WATCHLIST_MAX = 100;

/**
 * @param {string[]} argv - e.g. ['BTCUSDT,ETHUSDT', '--dry-run']
 * @returns {{ symbols: string[], dryRun: boolean, verify: boolean }}
 * @throws {Error} with every problem listed
 */
export function parseWatchlistArgs(argv) {
  const flags = argv.filter(a => a.startsWith('--'));
  const raw = argv.filter(a => !a.startsWith('--')).join(',');
  const errors = [];
  const unknownFlags = flags.filter(f => !['--dry-run', '--no-verify'].includes(f));
  if (unknownFlags.length) errors.push(`unknown flag(s): ${unknownFlags.join(', ')}`);

  const items = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!items.length) errors.push('no symbols given — pass e.g. BTCUSDT,ETHUSDT');

  const symbols = [];
  const dupes = [];
  for (const item of items) {
    const sym = item.toUpperCase();
    if (!/^[A-Z0-9]{2,20}USDT$/.test(sym)) { errors.push(`"${item}" is not a USDT-M symbol like BTCUSDT`); continue; }
    if (symbols.includes(sym)) { dupes.push(sym); continue; }
    symbols.push(sym);
  }
  if (dupes.length) errors.push(`duplicate symbol(s): ${[...new Set(dupes)].join(', ')}`);
  if (symbols.length > WATCHLIST_MAX) errors.push(`${symbols.length} symbols > max ${WATCHLIST_MAX}`);

  if (errors.length) throw new Error(errors.join('\n'));
  return { symbols, dryRun: flags.includes('--dry-run'), verify: !flags.includes('--no-verify') };
}

/**
 * Symbols not tradable as USDT-M perpetuals according to /fapi/v1/exchangeInfo.
 * @param {string[]} symbols
 * @param {Array<{ symbol: string, status: string, contractType: string, quoteAsset: string }>} exchangeSymbols
 */
export function untradableSymbols(symbols, exchangeSymbols) {
  const ok = new Set(exchangeSymbols
    .filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
    .map(s => s.symbol));
  return symbols.filter(s => !ok.has(s));
}

export function listDiff(before, after) {
  return {
    added: after.filter(s => !before.includes(s)),
    removed: before.filter(s => !after.includes(s)),
    unchanged: before.length === after.length && before.every((s, i) => s === after[i]),
  };
}
