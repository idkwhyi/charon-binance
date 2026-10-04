import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCandidate, rankCandidates, shouldUseLlm } from '../src/pipeline/candidateSelector.js';

function cand(symbol, { score = 6, rr = 2, volume = 1e8 } = {}) {
  return {
    symbol,
    obRR: rr,
    metrics: { volume24hUsdt: volume },
    signals: { meta: { entryConfirmation: { score } } },
  };
}

test('ranks by confirmation score first', () => {
  const picked = selectCandidate([cand('AAA', { score: 6, rr: 5 }), cand('BBB', { score: 8, rr: 2 })]);
  assert.equal(picked.symbol, 'BBB');
});

test('breaks score ties by R:R, then by 24h volume', () => {
  assert.equal(selectCandidate([cand('AAA', { rr: 2 }), cand('BBB', { rr: 3 })]).symbol, 'BBB');
  assert.equal(selectCandidate([cand('AAA', { volume: 1e8 }), cand('BBB', { volume: 2e8 })]).symbol, 'BBB');
});

test('full ties are broken by symbol so the pick is deterministic', () => {
  const a = selectCandidate([cand('ZZZ'), cand('AAA')]);
  const b = selectCandidate([cand('AAA'), cand('ZZZ')]);
  assert.equal(a.symbol, 'AAA');
  assert.equal(b.symbol, 'AAA');
});

test('skips symbols that already have an open position', () => {
  const picked = selectCandidate([cand('AAA', { score: 9 }), cand('BBB', { score: 6 })], new Set(['AAA']));
  assert.equal(picked.symbol, 'BBB');
  assert.deepEqual(rankCandidates([cand('AAA')], ['AAA']), []);
});

test('returns null when nothing is eligible', () => {
  assert.equal(selectCandidate([]), null);
  assert.equal(selectCandidate([cand('AAA')], new Set(['AAA'])), null);
});

test('missing metadata ranks below candidates that have it', () => {
  const bare = { symbol: 'AAA', metrics: {} };
  assert.equal(selectCandidate([bare, cand('BBB', { score: 3 })]).symbol, 'BBB');
});

test('LLM decides only when the global flag and strategy both enable it', () => {
  assert.equal(shouldUseLlm(false, { use_llm: true }), false);
  assert.equal(shouldUseLlm(true, { use_llm: false }), false);
  assert.equal(shouldUseLlm(true, { use_llm: true }), true);
  assert.equal(shouldUseLlm(true, null), false);
});
