import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shadowAgrees, shadowError } from '../src/pipeline/llmShadow.js';

// Note: recordLlmShadow itself is not exercised here — importing config loads
// .env, and a real LLM_API_KEY would make the test hit the network.

test('agrees when the LLM picks the same candidate as the selector', () => {
  assert.equal(shadowAgrees(5, { verdict: 'BUY_LONG', selected_candidate_id: 5 }), true);
  assert.equal(shadowAgrees(5, { verdict: 'BUY_LONG', selected_candidate_id: 6 }), false);
});

test('a PASS/WATCH agrees only if the selector picked nothing', () => {
  assert.equal(shadowAgrees(null, { verdict: 'PASS', selected_candidate_id: null }), true);
  assert.equal(shadowAgrees(5, { verdict: 'WATCH', selected_candidate_id: null }), false);
  assert.equal(shadowAgrees(undefined, {}), true);
});

test('LLM failures are reported as errors, not as disagreement', () => {
  assert.equal(shadowError({ risks: ['llm_error'], reason: 'LLM failed: timeout' }), 'LLM failed: timeout');
  assert.equal(shadowError({ risks: ['no_llm_decision'], reason: 'LLM disabled or LLM_API_KEY missing.' }), 'LLM disabled or LLM_API_KEY missing.');
  assert.equal(shadowError({ risks: ['high funding'] }), null);
});
