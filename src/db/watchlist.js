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

import { db } from './connection.js';
import { WATCHLIST } from '../config.js';

const KEY = 'watchlist:symbols';
const KEY_PINNED = 'watchlist:pinned'; // user-pinned symbols, never auto-removed

/**
 * Get current active watchlist (DB override or env fallback).
 * @returns {string[]}
 */
export function getWatchlist() {
  const row = db.prepare("SELECT value FROM strategy_config WHERE key = ?").get(KEY);
  if (!row) return [...WATCHLIST];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [...WATCHLIST];
  } catch {
    return [...WATCHLIST];
  }
}

/**
 * Get user-pinned symbols (always kept in watchlist).
 * @returns {string[]}
 */
export function getPinnedSymbols() {
  const row = db.prepare("SELECT value FROM strategy_config WHERE key = ?").get(KEY_PINNED);
  if (!row) return [];
  try { return JSON.parse(row.value) || []; } catch { return []; }
}

/**
 * Save watchlist to DB.
 * @param {string[]} symbols
 */
export function saveWatchlist(symbols) {
  const unique = [...new Set(symbols.map(s => s.toUpperCase().trim()).filter(Boolean))];
  db.prepare("INSERT OR REPLACE INTO strategy_config (key, value) VALUES (?, ?)")
    .run(KEY, JSON.stringify(unique));
  return unique;
}

/**
 * Add a symbol to watchlist (and pin it so auto-refresh won't remove it).
 * @param {string} symbol
 * @returns {{ added: boolean, symbol: string }}
 */
export function addToWatchlist(symbol) {
  const sym = symbol.toUpperCase().trim();
  const current = getWatchlist();
  if (current.includes(sym)) return { added: false, symbol: sym };

  saveWatchlist([...current, sym]);

  // Pin it
  const pinned = getPinnedSymbols();
  if (!pinned.includes(sym)) {
    db.prepare("INSERT OR REPLACE INTO strategy_config (key, value) VALUES (?, ?)")
      .run(KEY_PINNED, JSON.stringify([...pinned, sym]));
  }

  return { added: true, symbol: sym };
}

/**
 * Remove a symbol from watchlist and unpin it.
 * @param {string} symbol
 * @returns {{ removed: boolean, symbol: string }}
 */
export function removeFromWatchlist(symbol) {
  const sym = symbol.toUpperCase().trim();
  const current = getWatchlist();
  if (!current.includes(sym)) return { removed: false, symbol: sym };

  saveWatchlist(current.filter(s => s !== sym));

  // Unpin
  const pinned = getPinnedSymbols();
  db.prepare("INSERT OR REPLACE INTO strategy_config (key, value) VALUES (?, ?)")
    .run(KEY_PINNED, JSON.stringify(pinned.filter(s => s !== sym)));

  return { removed: true, symbol: sym };
}

/**
 * Merge auto-discovered symbols (top gainers) with current watchlist.
 * Pinned symbols are always preserved.
 * Auto symbols are capped to avoid scanning too many pairs.
 *
 * @param {string[]} autoSymbols - symbols from top gainer scan
 * @param {number} maxTotal - max total watchlist size
 */
export function mergeAutoSymbols(autoSymbols, maxTotal = 50) {
  const pinned = getPinnedSymbols();
  const current = getWatchlist();

  // Always keep pinned + env defaults
  const base = [...new Set([...pinned, ...WATCHLIST])];

  // Fill remaining slots with auto symbols not already in base
  const remaining = maxTotal - base.length;
  const extras = autoSymbols
    .filter(s => !base.includes(s))
    .slice(0, Math.max(0, remaining));

  const merged = [...new Set([...base, ...extras])];
  saveWatchlist(merged);
  return merged;
}
