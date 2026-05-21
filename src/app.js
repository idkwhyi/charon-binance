import { validateConfig, APP_NAME, TRADING_MODE, SIGNAL_SCAN_MS, POSITION_CHECK_MS } from './config.js';
import { initDb } from './db/connection.js';
import { initPgDb } from './db/pg-connection.js';
import { setupTelegram } from './telegram/commands.js';
import { initBot, sendStartup, sendTelegram } from './telegram/send.js';
import { warmupKlines, scanSignals, startWebSocket, setCandidateHandler } from './signals/scanner.js';
import { processSignalCandidate } from './pipeline/orchestrator.js';
import { monitorPositions } from './execution/positions.js';
import { startTopGainerRefresh } from './enrichment/topGainers.js';
import { getWatchlist } from './db/watchlist.js';
import { makeFailureTracker } from './utils.js';

export async function startCharon() {
  validateConfig();
  
  // Always initialize SQLite for compatibility
  initDb();
  
  // Also initialize PostgreSQL if configured
  if (process.env.USE_POSTGRES === 'true') {
    await initPgDb();
    console.log('[db] using PostgreSQL (with SQLite fallback)');
  } else {
    console.log('[db] using SQLite');
  }

  // Init Telegram bot (polling handled in commands.js)
  initBot();
  setupTelegram();

  // Wire signal handler
  setCandidateHandler(processSignalCandidate);

  // Start top gainer auto-screener (updates watchlist every 5 min)
  startTopGainerRefresh();

  // Warmup kline cache
  await warmupKlines();

  // Start WebSocket for real-time kline updates
  startWebSocket();

  // Send startup notification
  const watchlist = getWatchlist();
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
