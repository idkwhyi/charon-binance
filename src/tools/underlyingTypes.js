/**
 * Summary of exchangeInfo `underlyingType` values (npm run universe:check-types).
 * Pure: takes the `symbols` array of GET /fapi/v1/exchangeInfo.
 */

const MISSING = '(missing)';

function countBy(items, keyFn) {
  const out = {};
  for (const it of items) {
    const k = keyFn(it) ?? MISSING;
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/**
 * @param {object[]} symbols - exchangeInfo symbols
 * @param {{ examples?: number }} [opts]
 * @returns {{ total: number, types: Array<{ underlyingType, count, examples, subTypes, contractTypes, statuses, quoteAssets }> }}
 */
export function summarizeUnderlyingTypes(symbols = [], { examples = 8 } = {}) {
  const groups = new Map();
  for (const s of symbols) {
    const t = s.underlyingType ?? MISSING;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(s);
  }
  const types = [...groups].map(([underlyingType, list]) => ({
    underlyingType,
    count: list.length,
    // Prefer trading USDT perpetuals as examples: those are what the universe sees
    examples: [...list]
      .sort((a, b) => rank(a) - rank(b) || String(a.symbol).localeCompare(String(b.symbol)))
      .slice(0, examples).map(s => s.symbol),
    subTypes: countBy(list.flatMap(s => (Array.isArray(s.underlyingSubType) && s.underlyingSubType.length ? s.underlyingSubType : [null])), x => x),
    contractTypes: countBy(list, s => s.contractType),
    statuses: countBy(list, s => s.status),
    quoteAssets: countBy(list, s => s.quoteAsset),
  })).sort((a, b) => b.count - a.count);
  return { total: symbols.length, types };
}

function rank(s) {
  return (s.status === 'TRADING' ? 0 : 2) + (s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' ? 0 : 1);
}

const fmtCounts = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');

export function formatUnderlyingTypes({ total, types }) {
  const lines = [`exchangeInfo: ${total} symbols, ${types.length} underlyingType value(s)`, ''];
  for (const t of types) {
    lines.push(`${t.underlyingType}  —  ${t.count} symbol(s)`);
    lines.push(`  examples:      ${t.examples.join(', ')}`);
    lines.push(`  subTypes:      ${fmtCounts(t.subTypes)}`);
    lines.push(`  contractType:  ${fmtCounts(t.contractTypes)}`);
    lines.push(`  status:        ${fmtCounts(t.statuses)}`);
    lines.push(`  quoteAsset:    ${fmtCounts(t.quoteAssets)}`);
    lines.push('');
  }
  lines.push("Universe allowlist (src/universe/rules.js): only underlyingType 'COIN' passes.");
  return lines.join('\n');
}
