import { startCharon } from './src/app.js';
import { isEntryPoint } from './src/entry.js';

/** Boot the bot. Exported so the entry point can be imported (smoke test) without starting it. */
export function main() {
  return startCharon().catch(err => {
    console.error('[fatal]', err.message);
    process.exit(1);
  });
}

// Run only when executed directly (npm start / node index.js), not when imported.
if (isEntryPoint(import.meta.url)) main();
