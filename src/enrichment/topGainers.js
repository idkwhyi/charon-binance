/**
 * Top Gainer Auto-Screener
 *
 * Fetches all USDM futures tickers from Binance every N minutes,
 * filters by volume and price change, then merges into the active watchlist.
 *
 * Criteria for inclusion:
 *   - Symbol ends with USDT (USDM perpetual)
 *   - 24h quote volume >= TOP_GAINER_MIN_VOLUME_USDT
 *   - |priceChangePct| >= 2% (moving, not dead)
 *   - Not a stablecoin pair (BUSDUSDT, USDCUSDT, etc.)
 */

import { fetchTicker24h } from './binance.js';
import { mergeAutoSymbols, getWatchlist } from '../db/watchlist.js';
import { TOP_GAINER_ENABLED, TOP_GAINER_COUNT, TOP_GAINER_MIN_VOLUME_USDT, TOP_GAINER_REFRESH_MS } from '../config.js';
import { sendTelegram } from '../telegram/send.js';
import { fmtUsd } from '../format.js';

const STABLECOIN_PAIRS = new Set(['BUSDUSDT', 'USDCUSDT', 'TUSDUSDT', 'USDTUSDT', 'DAIUSDT', 'FDUSDUSDT']);

let refreshTimer = null;

/**
 * Fetch and return top gainers + top losers from Binance futures.
 * @returns {Promise<string[]>} sorted symbol list
 */
export async function fetchTopMovers() {
  const tickers = await fetchTicker24h(); // all symbols
  if (!Array.isArray(tickers)) return [];

  const filtered = tickers
    .filter(t => {
      const sym = String(t.symbol || '');
      const vol = Number(t.quoteVolume || 0);
      const pct = Math.abs(Number(t.priceChangePercent || 0));
      return (
        sym.endsWith('USDT') &&
        !STABLECOIN_PAIRS.has(sym) &&
        vol >= TOP_GAINER_MIN_VOLUME_USDT &&
        pct >= 2
      );
    })
    .sort((a, b) => Math.abs(Number(b.priceChangePercent)) - Math.abs(Number(a.priceChangePercent)));

  return filtered.slice(0, TOP_GAINER_COUNT).map(t => t.symbol);
}

/**
 * Run one top-gainer refresh cycle:
 * 1. Fetch top movers
 * 2. Merge into watchlist
 * 3. Send Telegram summary
 */
export async function refreshTopGainers(notify = true) {
  if (!TOP_GAINER_ENABLED) return;

  try {
    const movers = await fetchTopMovers();
    if (!movers.length) return;

    const before = getWatchlist();
    const after  = mergeAutoSymbols(movers, 50);

    const added   = after.filter(s => !before.includes(s));
    const removed = before.filter(s => !after.includes(s));

    console.log(`[top-gainers] watchlist updated: ${after.length} symbols (+${added.length} -${removed.length})`);

    if (notify && (added.length > 0 || removed.length > 0)) {
      const lines = [
        `📡 <b>Watchlist Auto-Updated</b>`,
        `Total: <b>${after.length} symbols</b>`,
      ];
      if (added.length)   lines.push(`➕ Added: <code>${added.join(', ')}</code>`);
      if (removed.length) lines.push(`➖ Removed: <code>${removed.join(', ')}</code>`);
      await sendTelegram(lines.join('\n'));
    }

    return after;
  } catch (err) {
    console.log(`[top-gainers] refresh failed: ${err.message}`);
  }
}

/**
 * Start periodic top-gainer refresh.
 */
export function startTopGainerRefresh() {
  if (!TOP_GAINER_ENABLED) {
    console.log('[top-gainers] disabled');
    return;
  }

  // Run immediately on startup
  refreshTopGainers(false).catch(() => {});

  refreshTimer = setInterval(() => {
    refreshTopGainers(true).catch(() => {});
  }, TOP_GAINER_REFRESH_MS);

  console.log(`[top-gainers] auto-refresh every ${TOP_GAINER_REFRESH_MS / 1000}s`);
}
