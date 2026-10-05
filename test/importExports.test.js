import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function jsFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Names a file imports from relative modules, both `import {..} from` and `const {..} = await import(..)`. */
export function namedRelativeImports(src) {
  const found = [];
  const patterns = [
    /import\s*\{([^{}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g,
    /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*await\s+import\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const names = m[1].split(',').map(s => s.trim()).filter(Boolean)
        .map(s => s.split(/\s+as\s+|\s*:\s*/)[0].trim());
      found.push({ spec: m[2], names });
    }
  }
  return found;
}

test('namedRelativeImports parses static, aliased and dynamic imports', () => {
  const src = "import { a, b as c } from './x.js';\nconst { d, e: f } = await import('../y.js').catch(() => ({}));";
  assert.deepEqual(namedRelativeImports(src), [
    { spec: './x.js', names: ['a', 'b'] },
    { spec: '../y.js', names: ['d', 'e'] },
  ]);
});

test('every named import in src/ and root scripts exists in the target module', async () => {
  const files = [
    ...await jsFiles(path.join(ROOT, 'src')),
    ...(await readdir(ROOT)).filter(f => f.endsWith('.js')).map(f => path.join(ROOT, f)),
  ];
  const missing = [];
  for (const file of files) {
    for (const { spec, names } of namedRelativeImports(await readFile(file, 'utf8'))) {
      const target = path.resolve(path.dirname(file), spec);
      const mod = await import(pathToFileURL(target).href);
      for (const n of names) if (!(n in mod)) missing.push(`${path.relative(ROOT, file)}: '${n}' from ${spec}`);
    }
  }
  assert.deepEqual(missing, []);
});
