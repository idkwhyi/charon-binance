/**
 * Top Gainer Auto-Screener
 *
 * Fetches all USDM futures tickers + exchangeInfo from Binance and applies
 * the universe rules (selectUniverse in src/universe/rules.js): pinned + env
 * defaults always kept, plus the current top movers; symbols that drop out
 * of the top N leave the watchlist.
 *
 * Universe now updates at 15m close (same as signal cycles) via updateUniverse(),
 * instead of a separate 5-minute timer.
 */

import { fetchTicker24h, fetchExchangeInfoAll } from './binance.js';
import { saveWatchlist, getWatchlist, getPinnedSymbols, invalidateWatchlistCache } from '../db/watchlist.js';
import { TOP_GAINER_ENABLED, WATCHLIST } from '../config.js';
import { sendTelegram } from '../telegram/send.js';
import { selectUniverse, diffUniverse, exchangeInfoMap } from '../universe/rules.js';

let last15mCloseTimeMs = 0;

/**
 * Calculate the last 15m candle close time (aligned to :00/:15/:30/:45 UTC).
 * E.g., if now is 14:37, the last closed 15m candle closed at 14:30.
 * @param {number} nowMs - current time in ms
 * @returns {number} last close time in ms
 */
function last15mCandle(nowMs) {
  const t = new Date(nowMs);
  const minutes = t.getUTCMinutes();
  const aligned = Math.floor(minutes / 15) * 15; // this is the last 15m boundary
  const closeT = new Date(t);
  closeT.setUTCMinutes(aligned);
  closeT.setUTCSeconds(0);
  closeT.setUTCMilliseconds(0);
  return closeT.getTime();
}

/**
 * Update the universe exactly once per 15m candle close (:00/:15/:30/:45 UTC).
 * Called at the start of every scanSignals() (every 30s), before the watchlist
 * is read. Only updates if a new 15m candle has closed since the last update.
 * @param {boolean} force - bypass candle check (used on startup)
 * @returns {Promise<{updated: boolean, symbols: string[], added: string[], removed: string[]}>}
 */
export async function updateUniverse(force = false) {
  if (!TOP_GAINER_ENABLED) return { updated: false, symbols: [], added: [], removed: [] };

  const nowMs = Date.now();
  const current15mMs = last15mCandle(nowMs);

  if (!force && current15mMs <= last15mCloseTimeMs) {
    return { updated: false, symbols: [], added: [], removed: [] };
  }

  last15mCloseTimeMs = current15mMs;

  try {
    const [tickers, infoSymbols] = await Promise.all([fetchTicker24h(), fetchExchangeInfoAll()]);
    // Without either snapshot the rules can't be applied: keep the current universe
    if (!Array.isArray(tickers) || tickers.length === 0 || !Array.isArray(infoSymbols) || infoSymbols.length === 0) {
      return { updated: false, symbols: [], added: [], removed: [] };
    }

    // All selection rules live in src/universe/rules.js (shared with the backtest).
    // Zero movers is a valid result: dynamic symbols leave, pinned + env stay.
    const before = await getWatchlist();
    const { symbols } = selectUniverse(tickers, {
      exchangeInfo: exchangeInfoMap(infoSymbols),
      pinned: await getPinnedSymbols(),
      envDefaults: WATCHLIST,
    });
    const after = await saveWatchlist(symbols);
    invalidateWatchlistCache();

    const { added, removed } = diffUniverse(before, after);

    if (added.length > 0 || removed.length > 0) {
      console.log(`[universe] updated at ${new Date(current15mMs).toISOString()}: ${after.length} symbols (+${added.length} -${removed.length})`);

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
