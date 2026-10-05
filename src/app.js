import { validateConfig, APP_NAME, TRADING_MODE, SIGNAL_SCAN_MS, POSITION_CHECK_MS } from './config.js';
import { initPgDb } from './db/pg-connection.js';
import { setupTelegram } from './telegram/commands.js';
import { initBot, sendStartup, sendTelegram } from './telegram/send.js';
import { warmupKlines, scanSignals, startWebSocket, setCycleHandler } from './signals/scanner.js';
import { processScanCycle } from './pipeline/orchestrator.js';
import { monitorPositions } from './execution/positions.js';
import { initUniverse } from './enrichment/topGainers.js';
import { getWatchlist } from './db/watchlist.js';
import { makeFailureTracker } from './utils.js';

export async function startCharon() {
  validateConfig();

  // Initialize PostgreSQL (required)
  await initPgDb();
  console.log('[db] using PostgreSQL');

  // Init Telegram bot (polling handled in commands.js)
  initBot();
  setupTelegram();

  // Wire signal handler
  setCycleHandler(processScanCycle);

  // Initialize universe (top gainer screener) — will update at 15m closes via orchestrator
  await initUniverse();

  // Warmup kline cache
  await warmupKlines();

  // Start WebSocket for real-time kline updates
  await startWebSocket();

  // Send startup notification
  const watchlist = await getWatchlist();
  await sendStartup(TRADING_MODE, watchlist);

  // Polling loops
  const trackScan      = makeFailureTracker('signal scanner', sendTelegram);
  const trackPositions = makeFailureTracker('position monitor', sendTelegram);

  // Initial scan
  await scanSignals().catch(err => console.log(`[scanner] initial scan: ${err.message}`));

  // Periodic signal scan
  setInterval(() => trackScan(() => scanSignals()), SIGNAL_SCAN_MS);

  // Position monitor
  setInterval(() => trackPositions(() => monitorPositions()), POSITION_CHECK_MS);

  console.log(`[bot] ${APP_NAME} running | mode=${TRADING_MODE} | watching ${watchlist.length} symbols`);
}
