#!/usr/bin/env node
/**
 * List every USDⓈ-M perpetual symbol ever listed (delisted included) with its
 * trading range, from data.binance.vision + current exchangeInfo. Public
 * endpoints only, no DB; the result is cached in .cache/universe/symbols.json.
 *
 *   npm run universe:symbols
 */

import { fetchExchangeInfoAll } from './src/enrichment/binance.js';
import { buildSymbolRegistry, formatRegistry } from './src/backtest/symbolRegistry.js';
import { isEntryPoint } from './src/entry.js';

async function main() {
  const registry = await buildSymbolRegistry({ exchangeInfoSymbols: await fetchExchangeInfoAll(), log: console.log });
  console.log(formatRegistry(registry));
}

// Only when executed directly: importing this file (tests) must not touch the DB or network
if (isEntryPoint(import.meta.url)) main().catch(err => {
  console.error('[universe:symbols] failed:', err.message);
  process.exit(1);
});
