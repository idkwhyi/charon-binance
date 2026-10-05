import { test } from 'node:test';
import assert from 'node:assert/strict';

// Test module imports
test('topGainers module exports updateUniverse and initUniverse', async () => {
  const mod = await import('../src/enrichment/topGainers.js');
  assert(typeof mod.updateUniverse === 'function');
  assert(typeof mod.initUniverse === 'function');
});
