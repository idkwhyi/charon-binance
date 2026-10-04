import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePool } from './helpers/fakePool.js';
import { getWatchlist, getPinnedSymbols, invalidateWatchlistCache } from '../src/db/watchlist.js';
import { candidateById, recentEligibleCandidates, parseCandidateRow } from '../src/db/candidates.js';
import { strategyById, getSetting } from '../src/db/settings.js';
import { WATCHLIST } from '../src/config.js';

beforeEach(() => invalidateWatchlistCache());

const kv = (map) => installFakePool((text, params) => (params[0] in map ? [{ value: map[params[0]] }] : []));

test('getWatchlist reads a JSONB array as pg returns it (no JSON.parse)', async () => {
  kv({ 'watchlist:symbols': ['AAAUSDT', 'BBBUSDT'] });
  assert.deepEqual(await getWatchlist(), ['AAAUSDT', 'BBBUSDT']);
});

test('getWatchlist still accepts a legacy JSON-string value', async () => {
  kv({ 'watchlist:symbols': '["CCCUSDT"]' });
  assert.deepEqual(await getWatchlist(), ['CCCUSDT']);
});

test('getWatchlist falls back to env WATCHLIST when unset or empty', async () => {
  kv({});
  assert.deepEqual(await getWatchlist(), WATCHLIST);
  invalidateWatchlistCache();
  kv({ 'watchlist:symbols': [] });
  assert.deepEqual(await getWatchlist(), WATCHLIST);
});

test('getPinnedSymbols reads a JSONB array', async () => {
  kv({ 'watchlist:pinned': ['PINUSDT'] });
  assert.deepEqual(await getPinnedSymbols(), ['PINUSDT']);
  kv({});
  assert.deepEqual(await getPinnedSymbols(), []);
});

const candidateObj = { symbol: 'BTCUSDT', direction: 'LONG', metrics: { markPrice: 100 } };

test('candidateById returns the candidate from a JSONB column (was always null)', async () => {
  installFakePool(() => [{ id: 5, candidate_json: candidateObj, filters_json: { passed: true } }]);
  const row = await candidateById(5);
  assert.ok(row, 'row must not be null');
  assert.equal(row.candidate.symbol, 'BTCUSDT');
  assert.equal(row.filters.passed, true);
});

test('recentEligibleCandidates parses JSONB rows (LLM used to get an empty list)', async () => {
  installFakePool(() => [{ id: 1, candidate_json: candidateObj, filters_json: null }]);
  const rows = await recentEligibleCandidates(10);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].filters, {});
});

test('parseCandidateRow accepts legacy string JSON too', () => {
  const row = parseCandidateRow({ candidate_json: JSON.stringify(candidateObj), filters_json: '{"passed":false}' });
  assert.equal(row.candidate.metrics.markPrice, 100);
  assert.equal(row.filters.passed, false);
});

test('strategy rows: object or legacy JSON string give the same effective strategy', async () => {
  installFakePool((text, params) => {
    if (/LIKE 'strategy:%'/.test(text)) return [{ key: 'strategy:a', value: { leverage: 3 } }, { key: 'strategy:b', value: '{"leverage":7}' }];
    return [];
  });
  assert.equal((await strategyById('a')).leverage, 3);
  assert.equal((await strategyById('b')).leverage, 7);
});

test('scalar settings are returned as decoded, not re-parsed', async () => {
  kv({ active_strategy: 'extreme_ob', agent_enabled: false, llm_min_confidence: 70 });
  assert.equal(await getSetting('active_strategy'), 'extreme_ob');
  assert.equal(await getSetting('agent_enabled'), false);
  assert.equal(await getSetting('llm_min_confidence'), 70);
});
