import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStrategyArgs, diffPatch, formatHours } from '../src/tools/strategyPatch.js';
import { parseWatchlistArgs, untradableSymbols, listDiff } from '../src/tools/watchlistInput.js';

// ── strategy:set ──────────────────────────────────────────────────────────────

test('max_hold_hours=4 becomes max_hold_ms = 14400000', () => {
  const r = parseStrategyArgs(['extreme_ob', 'max_hold_hours=4']);
  assert.deepEqual(r, { strategyId: 'extreme_ob', patch: { max_hold_ms: 14_400_000 }, dryRun: false, create: false });
  assert.equal(formatHours(14_400_000), '14400000 ms (4h)');
});

test('several keys, types converted, flags parsed', () => {
  const r = parseStrategyArgs(['extreme_ob', 'leverage=3', 'use_llm=false', 'signal_types=extreme_ob, volume_spike', 'sl_percent=-1.2', '--dry-run']);
  assert.deepEqual(r.patch, { leverage: 3, use_llm: false, signal_types: 'extreme_ob,volume_spike', sl_percent: -1.2 });
  assert.equal(r.dryRun, true);
});

test('rejects bad input with every problem listed', () => {
  const cases = [
    [['extreme_ob'], /nothing to set/],
    [['Extreme-OB', 'leverage=3'], /strategy id/],
    [['extreme_ob', 'max_hold_hours=abc'], /max_hold_hours: "abc" is not a number/],
    [['extreme_ob', 'max_hold_hours=0'], /outside 0.25..168/],
    [['extreme_ob', 'max_hold_hours=500'], /outside 0.25..168/],
    [['extreme_ob', 'max_hold_hours=4', 'max_hold_ms=14400000'], /both set max_hold_ms/],
    [['extreme_ob', 'leverage=2.5'], /not an integer/],
    [['extreme_ob', 'sl_percent=1.5'], /outside -50..-0.1/],
    [['extreme_ob', 'use_llm=yes'], /true or false/],
    [['extreme_ob', 'signal_types=extreme_ob,foo'], /unknown signal type\(s\): foo/],
    [['extreme_ob', 'max_hold=4'], /unknown key "max_hold"/],
    [['extreme_ob', 'leverage'], /not key=value/],
    [['extreme_ob', 'leverage=3', '--force'], /unknown flag/],
  ];
  for (const [argv, re] of cases) assert.throws(() => parseStrategyArgs(argv), re, argv.join(' '));
  const multi = (() => { try { parseStrategyArgs(['extreme_ob', 'leverage=99', 'use_llm=maybe']); } catch (e) { return e.message; } })();
  assert.equal(multi.split('\n').length, 2, 'both errors reported');
});

test('diffPatch marks only real changes (re-running is a no-op)', () => {
  assert.deepEqual(diffPatch({ max_hold_ms: 172_800_000, leverage: 5 }, { max_hold_ms: 14_400_000 }),
    [{ field: 'max_hold_ms', before: 172_800_000, after: 14_400_000, changed: true }]);
  assert.equal(diffPatch({ max_hold_ms: 14_400_000 }, { max_hold_ms: 14_400_000 })[0].changed, false);
  assert.equal(diffPatch(null, { leverage: 3 })[0].changed, true);
});

// ── watchlist:set ─────────────────────────────────────────────────────────────

const TEN = 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,DOTUSDT,LINKUSDT';

test('parses the requested 10-symbol list in order', () => {
  const r = parseWatchlistArgs([TEN]);
  assert.deepEqual(r.symbols, TEN.split(','));
  assert.equal(r.verify, true);
  assert.deepEqual(parseWatchlistArgs(['btcusdt, ethusdt', '--dry-run', '--no-verify']), { symbols: ['BTCUSDT', 'ETHUSDT'], dryRun: true, verify: false });
});

test('rejects bad symbols, duplicates, empty and unknown flags', () => {
  assert.throws(() => parseWatchlistArgs([]), /no symbols/);
  assert.throws(() => parseWatchlistArgs(['BTCUSDT,BTC-USDT']), /"BTC-USDT" is not a USDT-M symbol/);
  assert.throws(() => parseWatchlistArgs(['BTCUSD']), /not a USDT-M symbol/);
  assert.throws(() => parseWatchlistArgs(['BTCUSDT,ETHUSDT,btcusdt']), /duplicate symbol\(s\): BTCUSDT/);
  assert.throws(() => parseWatchlistArgs(['BTCUSDT', '--force']), /unknown flag/);
  const many = Array.from({ length: 101 }, (_, i) => `S${i}USDT`).join(',');
  assert.throws(() => parseWatchlistArgs([many]), /101 symbols > max 100/);
});

test('exchange check: only TRADING USDT perpetuals pass', () => {
  const info = [
    { symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT' },
    { symbol: 'ETHUSDT', status: 'SETTLING', contractType: 'PERPETUAL', quoteAsset: 'USDT' },
    { symbol: 'BTCUSDT_260327', status: 'TRADING', contractType: 'CURRENT_QUARTER', quoteAsset: 'USDT' },
  ];
  assert.deepEqual(untradableSymbols(['BTCUSDT', 'ETHUSDT', 'FAKEUSDT'], info), ['ETHUSDT', 'FAKEUSDT']);
});

test('listDiff reports added/removed and detects a no-op', () => {
  assert.deepEqual(listDiff(['A', 'B'], ['B', 'C']), { added: ['C'], removed: ['A'], unchanged: false });
  assert.equal(listDiff(['A', 'B'], ['A', 'B']).unchanged, true);
});

test('both scripts are wired in package.json and write only inside a transaction', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.scripts['strategy:set'], 'node set_strategy.js');
  assert.equal(pkg.scripts['watchlist:set'], 'node set_watchlist.js');
  for (const f of ['set_strategy.js', 'set_watchlist.js']) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /BEGIN/); assert.match(src, /FOR UPDATE/); assert.match(src, /ROLLBACK/); assert.match(src, /COMMIT/);
    assert.ok(src.indexOf('parse') < src.indexOf('new pg.Pool'), `${f} validates input before connecting`);
  }
});
