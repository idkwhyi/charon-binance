#!/usr/bin/env node
/**
 * List every underlyingType value in Binance USDⓈ-M exchangeInfo, with symbol
 * counts and examples — read-only (one public GET, no DB, no API key).
 *
 *   npm run universe:check-types
 */

import { fetchExchangeInfoAll } from './src/enrichment/binance.js';
import { summarizeUnderlyingTypes, formatUnderlyingTypes } from './src/tools/underlyingTypes.js';

async function main() {
  const symbols = await fetchExchangeInfoAll();
  console.log(formatUnderlyingTypes(summarizeUnderlyingTypes(symbols)));
}

main().catch(err => {
  console.error('[universe:check-types] failed:', err.message);
  process.exit(1);
});
