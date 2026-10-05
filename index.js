import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startCharon } from './src/app.js';

/** Boot the bot. Exported so the entry point can be imported (smoke test) without starting it. */
export function main() {
  return startCharon().catch(err => {
    console.error('[fatal]', err.message);
    process.exit(1);
  });
}

// Run only when executed directly (npm start / node index.js), not when imported.
// realpath.native: same file reached via a symlink or different path casing still counts.
const isEntry = process.argv[1] && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
if (isEntry) main();
