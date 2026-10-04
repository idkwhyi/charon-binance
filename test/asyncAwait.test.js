import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { installFakePool } from './helpers/fakePool.js';
import { normalizeDecision } from '../src/pipeline/llm.js';

function jsFiles(dir) {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? jsFiles(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('normalizeDecision resolves settings instead of leaking Promises', async () => {
  installFakePool((text, params) => (params[0] === 'default_tp_percent' ? [{ value: 3 }] : []));
  const d = await normalizeDecision({ verdict: 'BUY_LONG', confidence: 80 });
  assert.equal(d.suggested_tp_percent, 3, 'from settings');
  assert.equal(d.suggested_sl_percent, -1.5, 'fallback default');
  assert.equal(typeof d.suggested_tp_percent, 'number');
  const given = await normalizeDecision({ verdict: 'PASS', suggested_tp_percent: 4, suggested_sl_percent: -2 });
  assert.equal(given.suggested_tp_percent, 4);
  assert.equal(given.suggested_sl_percent, -2);
});

test('no async function result is assigned or used as a value without await', () => {
  const files = jsFiles('src');
  const asyncNames = new Set();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/async function (\w+)/g)) asyncNames.add(m[1]);
  }
  const offenders = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      for (const name of asyncNames) {
        // `x = fn(`, `{ a } = fn(`, `|| fn(`, `key: fn(` — a Promise used as data
        // (a leading `: fn(` is a ternary branch, e.g. after `return`, and is fine)
        const re = new RegExp(`(=|\\|\\||\\?\\?|\\w\\s*:)\\s*${name}\\(`);
        if (re.test(line) && !line.includes(`await ${name}(`) && !/^\s*(\*|\/\/)/.test(line)) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      }
    });
  }
  assert.deepEqual(offenders, []);
});
