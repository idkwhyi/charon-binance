import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePool } from './helpers/fakePool.js';
import { hasOpenPosition } from '../src/db/positions.js';

test('hasOpenPosition is true only when that symbol has an open row', async () => {
  const open = new Set(['BTCUSDT']);
  const calls = installFakePool((text, params) => (open.has(params[0]) ? [{ '?column?': 1 }] : []));

  assert.equal(await hasOpenPosition('BTCUSDT'), true);
  assert.equal(await hasOpenPosition('ETHUSDT'), false);
  assert.match(calls[0].text, /status = 'open'/);
  assert.match(calls[0].text, /symbol = \$1/);
});
