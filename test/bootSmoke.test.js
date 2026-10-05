import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Boot smoke test: every module under src/ and the entry point must load and link.
// Catches what `node --check` cannot, e.g. importing an export that no longer exists
// (npm start failing with "does not provide an export named ...").

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function jsFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}

for (const file of await jsFiles(path.join(ROOT, 'src'))) {
  test(`loads ${path.relative(ROOT, file)}`, async () => {
    await import(pathToFileURL(file).href);
  });
}

test('entry point index.js loads without starting the bot and exposes main()', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
  assert.equal(typeof mod.main, 'function');
});
