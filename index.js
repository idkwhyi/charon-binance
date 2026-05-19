import { startCharon } from './src/app.js';

startCharon().catch(err => {
  console.error('[fatal]', err.message);
  process.exit(1);
});
