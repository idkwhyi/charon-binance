/**
 * Top Gainer Auto-Screener
 *
 * Fetches all USDM futures tickers from Binance and evaluates them against
 * the universe selection rules (see src/universe/rules.js). Merges top movers
 * into the active watchlist (pinned + env defaults always preserved).
 *
 * Universe now updates at 15m close (same as signal cycles) via updateUniverse(),
 * instead of a separate 5-minute timer.
 */

import { fetchTicker24h } from './binance.js';
import { mergeAutoSymbols, getWatchlist, getPinnedSymbols, invalidateWatchlistCache } from '../db/watchlist.js';
import { TOP_GAINER_ENABLED, TOP_GAINER_COUNT, TOP_GAINER_MIN_VOLUME_USDT, WATCHLIST } from '../config.js';
import { sendTelegram } from '../telegram/send.js';
import { universeCriteria, selectTopMovers } from '../universe/rules.js';

let lastUpdateMs = 0;
const MIN_UPDATE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Update the universe once if 15+ minutes have passed since last update.
 * Called from orchestrator at each scan cycle (at least at 15m close, possibly more frequent).
 * @param {boolean} force - bypass time check (used on startup)
 * @returns {Promise<{updated: boolean, symbols: string[], added: string[], removed: string[]}>}
 */
export async function updateUniverse(force = false) {
  if (!TOP_GAINER_ENABLED) return { updated: false, symbols: [], added: [], removed: [] };

  const now = Date.now();
  if (!force && now - lastUpdateMs < MIN_UPDATE_INTERVAL_MS) {
    return { updated: false, symbols: [], added: [], removed: [] };
  }

  lastUpdateMs = now;

  try {
    const tickers = await fetchTicker24h();
    if (!Array.isArray(tickers) || tickers.length === 0) {
      return { updated: false, symbols: [], added: [], removed: [] };
    }

    const criteria = universeCriteria({
      minVolume24hUsdt: TOP_GAINER_MIN_VOLUME_USDT,
      minAbsChangePercent: 2,
      minOpenInterestUsdt: 0, // OI filter not used in live universe selection yet
      excludeNonCrypto: true,
    });

    const movers = selectTopMovers(tickers, criteria)
      .slice(0, TOP_GAINER_COUNT);

    if (movers.length === 0) {
      return { updated: false, symbols: [], added: [], removed: [] };
    }

    const before = await getWatchlist();
    const pinned = await getPinnedSymbols();
    const after = await mergeAutoSymbols(movers, 50);
    invalidateWatchlistCache();

    const added = after.filter(s => !before.includes(s));
    const removed = before.filter(s => !after.includes(s));

    if (added.length > 0 || removed.length > 0) {
      console.log(`[universe] updated at ${new Date(now).toISOString()}: ${after.length} symbols (+${added.length} -${removed.length})`);

      const lines = [
        `📡 <b>Watchlist Auto-Updated</b>`,
        `Total: <b>${after.length} symbols</b>`,
      ];
      if (added.length) lines.push(`➕ Added: <code>${added.slice(0, 10).join(', ')}${added.length > 10 ? '...' : ''}</code>`);
      if (removed.length) lines.push(`➖ Removed: <code>${removed.slice(0, 10).join(', ')}${removed.length > 10 ? '...' : ''}</code>`);
      await sendTelegram(lines.join('\n'));
    }

    return { updated: true, symbols: after, added, removed };
  } catch (err) {
    console.log(`[universe] update failed: ${err.message}`);
    return { updated: false, symbols: [], added: [], removed: [] };
  }
}

/**
 * Initialize universe on bot startup (force update, no interval).
 */
export async function initUniverse() {
  if (!TOP_GAINER_ENABLED) {
    console.log('[universe] disabled');
    return;
  }

  console.log('[universe] initializing');
  await updateUniverse(true).catch(err =>
    console.log(`[universe] init failed: ${err.message}`)
  );
}
