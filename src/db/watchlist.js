/**
 * Dynamic Watchlist DB Layer
 *
 * Watchlist symbols are stored in strategy_config table with key 'watchlist:symbols'.
 * Falls back to WATCHLIST env var if DB has no custom list.
 *
 * Sources:
 *   - Manual: user adds/removes via Telegram commands
 *   - Auto:   top gainers fetched from Binance every N minutes
 */

import { query as pgQuery } from './pg-connection.js';
import { WATCHLIST } from '../config.js';

const KEY = 'watchlist:symbols';
const KEY_PINNED = 'watchlist:pinned'; // user-pinned symbols, never auto-removed

// Cache for watchlist to avoid frequent DB hits
let cachedWatchlist = [...WATCHLIST];
let cacheExpiry = 0;

/**
 * Get current active watchlist (DB override or env fallback).
 * @returns {Promise<string[]>}
 */
export async function getWatchlist() {
  // Return cached if fresh
  if (Date.now() < cacheExpiry) {
    return [...cachedWatchlist];
  }

  try {
    const result = await pgQuery("SELECT value FROM strategy_config WHERE key = $1", [KEY]);
    if (result.rows.length === 0) {
      cachedWatchlist = [...WATCHLIST];
    } else {
      try {
        const parsed = JSON.parse(result.rows[0].value);
        cachedWatchlist = Array.isArray(parsed) && parsed.length > 0 ? parsed : [...WATCHLIST];
      } catch {
        cachedWatchlist = [...WATCHLIST];
      }
    }
    cacheExpiry = Date.now() + 60000; // Cache for 1 minute
    return [...cachedWatchlist];
  } catch (err) {
    console.error('[watchlist] get failed, using fallback:', err.message);
    return [...WATCHLIST];
  }
}

/**
 * Get user-pinned symbols (always kept in watchlist).
 * @returns {Promise<string[]>}
 */
export async function getPinnedSymbols() {
  try {
    const result = await pgQuery("SELECT value FROM strategy_config WHERE key = $1", [KEY_PINNED]);
    if (result.rows.length === 0) return [];
    return JSON.parse(result.rows[0].value) || [];
  } catch {
    return [];
  }
}

/**
 * Save watchlist to DB.
 * @param {string[]} symbols
 * @returns {Promise<string[]>}
 */
export async function saveWatchlist(symbols) {
  const unique = [...new Set(symbols.map(s => s.toUpperCase().trim()).filter(Boolean))];
  try {
    await pgQuery(
      "INSERT INTO strategy_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [KEY, JSON.stringify(unique)]
    );
    cachedWatchlist = unique;
    cacheExpiry = Date.now() + 60000;
  } catch (err) {
    console.error('[watchlist] save failed:', err.message);
  }
  return unique;
}

/**
 * Add a symbol to watchlist (and pin it so auto-refresh won't remove it).
 * @param {string} symbol
 * @returns {Promise<{added: boolean, symbol: string}>}
 */
export async function addToWatchlist(symbol) {
  const sym = symbol.toUpperCase().trim();
  const current = await getWatchlist();
  if (current.includes(sym)) return { added: false, symbol: sym };

  await saveWatchlist([...current, sym]);

  // Pin it
  const pinned = await getPinnedSymbols();
  if (!pinned.includes(sym)) {
    try {
      await pgQuery(
        "INSERT INTO strategy_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [KEY_PINNED, JSON.stringify([...pinned, sym])]
      );
    } catch (err) {
      console.error('[watchlist] pin failed:', err.message);
    }
  }

  return { added: true, symbol: sym };
}

/**
 * Remove a symbol from watchlist and unpin it.
 * @param {string} symbol
 * @returns {Promise<{removed: boolean, symbol: string}>}
 */
export async function removeFromWatchlist(symbol) {
  const sym = symbol.toUpperCase().trim();
  const current = await getWatchlist();
  if (!current.includes(sym)) return { removed: false, symbol: sym };

  await saveWatchlist(current.filter(s => s !== sym));

  // Unpin
  const pinned = await getPinnedSymbols();
  try {
    await pgQuery(
      "INSERT INTO strategy_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [KEY_PINNED, JSON.stringify(pinned.filter(s => s !== sym))]
    );
  } catch (err) {
    console.error('[watchlist] unpin failed:', err.message);
  }

  return { removed: true, symbol: sym };
}

/**
 * Merge auto-discovered symbols (top gainers) with current watchlist.
 * Pinned symbols are always preserved.
 * Auto symbols are capped to avoid scanning too many pairs.
 *
 * @param {string[]} autoSymbols - symbols from top gainer scan
 * @param {number} maxTotal - max total watchlist size
 * @returns {Promise<string[]>}
 */
export async function mergeAutoSymbols(autoSymbols, maxTotal = 50) {
  const pinned = await getPinnedSymbols();
  const current = await getWatchlist();

  // Always keep pinned + env defaults
  const base = [...new Set([...pinned, ...WATCHLIST])];

  // Fill remaining slots with auto symbols not already in base
  const remaining = maxTotal - base.length;
  const extras = autoSymbols
    .filter(s => !base.includes(s))
    .slice(0, Math.max(0, remaining));

  const merged = [...new Set([...base, ...extras])];
  await saveWatchlist(merged);
  return merged;
}
