/**
 * Format a number as USD string.
 */
export function fmtUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'N/A';
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return `$${v.toFixed(4)}`;
}

/**
 * Format a percentage number.
 */
export function fmtPct(n, decimals = 2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'N/A';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(decimals)}%`;
}

/**
 * Escape HTML for Telegram HTML parse mode.
 */
export function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Direction emoji.
 */
export function dirEmoji(direction) {
  return direction === 'SHORT' ? '🔴' : '🟢';
}
