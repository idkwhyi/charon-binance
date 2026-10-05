/**
 * Which environment variables the code reads, and which ones a .env file sets
 * that nothing reads any more (shown as a warning by npm run settings:show).
 */

import fs from 'node:fs';
import path from 'node:path';

/** Read by Node/libraries rather than our code: never flagged. */
export const ENV_READ_ELSEWHERE = new Set(['NODE_ENV', 'NODE_OPTIONS', 'TZ', 'DEBUG']);

/** Retired variables with what replaced them. */
export const RETIRED_ENV_HINTS = {
  TOP_GAINER_COUNT: 'universe rules are fixed in src/universe/rules.js (UNIVERSE_RULES)',
  TOP_GAINER_MIN_VOLUME_USDT: 'universe rules are fixed in src/universe/rules.js (UNIVERSE_RULES)',
  TOP_GAINER_REFRESH_MS: 'the universe refreshes at every 15m close',
};

/** Variable names referenced in source text, both as a property and as a quoted key of process.env. */
export function envVarsInSource(text) {
  return [...String(text).matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[\s*['"]([A-Z0-9_]+)['"]\s*\])/g)].map(m => m[1] || m[2]);
}

/** Every env var read by .js files under src/, the root scripts and migrations/. */
export function envVarsReadByCode(rootDir) {
  const files = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(rootDir, 'src'));
  walk(path.join(rootDir, 'migrations'));
  files.push(...fs.readdirSync(rootDir).filter(f => f.endsWith('.js')).map(f => path.join(rootDir, f)));
  return new Set(files.flatMap(f => envVarsInSource(fs.readFileSync(f, 'utf8'))));
}

/**
 * Keys set in the .env file that no code reads, with a hint for retired ones.
 * @param {string[]} envFileKeys
 * @param {Set<string>} readByCode
 * @returns {Array<{ name: string, hint: string|null }>}
 */
export function unusedEnvVars(envFileKeys, readByCode) {
  return envFileKeys
    .filter(k => !readByCode.has(k) && !ENV_READ_ELSEWHERE.has(k))
    .sort()
    .map(name => ({ name, hint: RETIRED_ENV_HINTS[name] || null }));
}
