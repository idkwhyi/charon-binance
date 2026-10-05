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

// Root scripts and the migration runner only run main() when executed directly:
// importing them must not connect to the DB, call the network or exit.
const ROOT_SCRIPTS = [
  ...(await readdir(ROOT)).filter(f => f.endsWith('.js')).sort(),
  'migrations/migrate.js',
];

test('root scripts import without side effects (no DB, no network, no exit)', async () => {
  const pg = (await import('pg')).default;
  const axios = (await import('axios')).default;
  const calls = [];
  const saved = { query: pg.Pool.prototype.query, connect: pg.Pool.prototype.connect, get: axios.get, post: axios.post, exit: process.exit };
  pg.Pool.prototype.query = async function () { calls.push('pg.query'); throw new Error('no DB in tests'); };
  pg.Pool.prototype.connect = async function () { calls.push('pg.connect'); throw new Error('no DB in tests'); };
  axios.get = async (url) => { calls.push(`GET ${url}`); throw new Error('no network in tests'); };
  axios.post = async (url) => { calls.push(`POST ${url}`); throw new Error('no network in tests'); };
  process.exit = (code) => { calls.push(`exit(${code})`); };
  try {
    for (const f of ROOT_SCRIPTS) await import(pathToFileURL(path.join(ROOT, f)).href);
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); // let any stray main() run
  } finally {
    Object.assign(pg.Pool.prototype, { query: saved.query, connect: saved.connect });
    Object.assign(axios, { get: saved.get, post: saved.post });
    process.exit = saved.exit;
  }
  assert.ok(ROOT_SCRIPTS.length >= 9, ROOT_SCRIPTS.join(','));
  assert.deepEqual(calls, []);
});

test('a root script still runs main() when executed directly', async () => {
  const { spawnSync } = await import('node:child_process');
  // set_strategy with no arguments prints usage and exits 1 before opening the DB
  const r = spawnSync(process.execPath, [path.join(ROOT, 'set_strategy.js')], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /Usage: npm run strategy:set/);
});
