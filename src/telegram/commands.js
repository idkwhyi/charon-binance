import TelegramBot from 'node-telegram-bot-api';
import {
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TRADING_MODE,
} from '../config.js';
import { activeStrategy, allStrategyIds, setStrategySetting, setActiveSetting } from '../db/settings.js';
import { openPositions, pnlSummary, recentClosedPositions } from '../db/positions.js';
import { getTradeIntent, updateTradeIntentStatus } from '../db/decisions.js';
import { createLivePosition } from '../db/positions.js';
import { executeFuturesBuy } from '../execution/futuresExecutor.js';
import { openPositionsList, candidateSummary } from './format.js';
import { sendTelegram, sendPositionOpen } from './send.js';
import { fmtUsd, fmtPct, escapeHtml } from '../format.js';
import { getWatchlist, addToWatchlist, removeFromWatchlist, getPinnedSymbols } from '../db/watchlist.js';
import { refreshTopGainers } from '../enrichment/topGainers.js';
import { reconnectWebSocket, warmupKlines } from '../signals/scanner.js';
import { getVirtualBalanceStats, getBalanceSummary, resetVirtualBalance, initializeVirtualBalance } from '../db/virtualBalance.js';
import { addLesson, getActiveLessons, confidenceCalibration } from '../db/learning.js';

let bot = null;

export function setupTelegram() {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  console.log('[telegram] bot polling started');

  bot.on('message', async (msg) => {
    if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
    const text = msg.text || '';
    const [cmd, ...args] = text.trim().split(/\s+/);

    try {
      if (cmd === '/start' || cmd === '/help') await handleHelp(msg);
      else if (cmd === '/menu') await handleMenu(msg);
      else if (cmd === '/strategy') await handleStrategy(msg, args);
      else if (cmd === '/stratset') await handleStratset(msg, args);
      else if (cmd === '/positions') await handlePositions(msg);
      else if (cmd === '/pnl') await handlePnl(msg);
      else if (cmd === '/watchlist') await handleWatchlist(msg);
      else if (cmd === '/watch') await handleWatch(msg, args);
      else if (cmd === '/unwatch') await handleUnwatch(msg, args);
      else if (cmd === '/topgainers') await handleTopGainers(msg);
      else if (cmd === '/scan') await handleScan(msg);
      else if (cmd === '/debug') await handleDebug(msg, args);
      else if (cmd === '/lesson') await handleLesson(msg, args);
      else if (cmd === '/lessons') await handleLessons(msg);
      else if (cmd === '/balance') await handleBalance(msg);
      else if (cmd === '/reset_balance') await handleResetBalance(msg, args);
      else if (cmd === '/backtest') await handleBacktest(msg);
      else if (cmd === '/stats') await handleStats(msg, args);
    } catch (err) {
      await reply(msg, `❌ Error: ${escapeHtml(err.message)}`);
    }
  });

  // Handle confirm/reject buttons
  bot.on('callback_query', async (query) => {
    if (String(query.message.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
    const [action, id] = (query.data || '').split(':');

    if (action === 'intent_approve') {
      await handleIntentApprove(query, Number(id));
    } else if (action === 'intent_reject') {
      await handleIntentReject(query, Number(id));
    } else if (action === 'strategy_select') {
      await handleStrategySelect(query, id);
    }
    await bot.answerCallbackQuery(query.id).catch(() => {});
  });

  return bot;
}

async function reply(msg, text) {
  await bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
}

async function handleHelp(msg) {
  await reply(msg, [
    `🤖 <b>Charon Binance Futures</b>`,
    ``,
    `/menu — Main menu`,
    `/strategy — Show/switch strategy`,
    `/stratset &lt;id&gt; &lt;key&gt; &lt;value&gt; — Edit strategy setting`,
    `/positions — Open positions`,
    `/pnl — PnL summary`,
    `/watchlist — Show watchlist`,
    `/watch &lt;SYMBOL&gt; — Add symbol to watchlist`,
    `/unwatch &lt;SYMBOL&gt; — Remove symbol from watchlist`,
    `/topgainers — Refresh top gainers now`,
    `/scan — Force scan signals now`,
    `/debug &lt;SYMBOL&gt; — Diagnose why a symbol has no signal`,
    `/lesson &lt;text&gt; — Add a learning lesson`,
    `/lessons — List active lessons`,
    ``,
    `<b>💰 Dry Run / Backtesting:</b>`,
    `/balance — Show virtual balance (dry_run mode)`,
    `/reset_balance [amount] — Reset virtual balance (default: 1000 USDT)`,
    `/backtest — Show backtest performance summary`,
    `/stats confidence — LLM confidence vs actual win rate`,
  ].join('\n'));
}

async function handleMenu(msg) {
  const strat = activeStrategy();
  await bot.sendMessage(msg.chat.id, [
    `📊 <b>Charon Binance Futures</b>`,
    `Mode: <code>${TRADING_MODE}</code> | Strategy: <code>${strat.id}</code>`,
    `Leverage: <b>${strat.leverage}x</b> | TP: <b>${fmtPct(strat.tp_percent)}</b> | SL: <b>${fmtPct(strat.sl_percent)}</b>`,
  ].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Positions', callback_data: 'positions' }, { text: '📈 PnL', callback_data: 'pnl' }],
        [{ text: '🔀 Strategy', callback_data: 'strategy_list' }, { text: '⚡ Scan Now', callback_data: 'scan' }],
      ],
    },
  });
}

async function handleStrategy(msg, args) {
  if (args[0]) {
    const id = args[0].toLowerCase();
    const all = allStrategyIds();
    if (!all.includes(id)) {
      return reply(msg, `❌ Unknown strategy. Available: ${all.join(', ')}`);
    }
    setActiveSetting('active_strategy', id);
    const strat = activeStrategy();
    return reply(msg, [
      `✅ Strategy switched to <b>${id}</b>`,
      `Leverage: ${strat.leverage}x | TP: ${fmtPct(strat.tp_percent)} | SL: ${fmtPct(strat.sl_percent)}`,
      `LLM: ${strat.use_llm ? 'on' : 'off'} | Signals: ${strat.signal_types}`,
    ].join('\n'));
  }

  const strat = activeStrategy();
  const all = allStrategyIds();
  const buttons = all.map(id => [{ text: id === strat.id ? `✅ ${id}` : id, callback_data: `strategy_select:${id}` }]);
  await bot.sendMessage(msg.chat.id, `Current: <b>${strat.id}</b>\nSelect strategy:`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
}

async function handleStratset(msg, args) {
  const [stratId, key, ...valueParts] = args;
  if (!stratId || !key || !valueParts.length) {
    return reply(msg, 'Usage: /stratset &lt;strategy_id&gt; &lt;key&gt; &lt;value&gt;');
  }
  const value = valueParts.join(' ');
  setStrategySetting(stratId, key, value);
  const strat = activeStrategy();
  reply(msg, `✅ <b>${stratId}.${key}</b> = <code>${escapeHtml(value)}</code>`);
}

async function handlePositions(msg) {
  const positions = await openPositions();
  await reply(msg, openPositionsList(positions));
}

async function handlePnl(msg) {
  const summary = await pnlSummary();
  const winRate = summary.total > 0 ? ((summary.wins / (summary.wins + summary.losses)) * 100).toFixed(1) : 'N/A';
  await reply(msg, [
    `📈 <b>PnL Summary</b>`,
    `Total trades: <b>${summary.total}</b>`,
    `Wins: <b>${summary.wins}</b> | Losses: <b>${summary.losses}</b>`,
    `Win rate: <b>${winRate}%</b>`,
    `Total PnL: <b>${summary.total_pnl_usdt >= 0 ? '+' : ''}${Number(summary.total_pnl_usdt || 0).toFixed(2)} USDT</b>`,
    `Open positions: <b>${summary.open_count}</b>`,
  ].join('\n'));
}

async function handleWatchlist(msg) {
  const watchlist = getWatchlist();
  const pinned    = getPinnedSymbols();
  const lines = watchlist.map(s => {
    const tag = pinned.includes(s) ? ' 📌' : ' 🤖';
    return `• <code>${s}</code>${tag}`;
  });
  await reply(msg, [
    `👀 <b>Watchlist (${watchlist.length})</b>`,
    `📌 = pinned by you | 🤖 = auto from top gainers`,
    ``,
    ...lines,
  ].join('\n'));
}

async function handleWatch(msg, args) {
  if (!args[0]) return reply(msg, 'Usage: /watch &lt;SYMBOL&gt;\nContoh: /watch SOLUSDT');
  const symbol = args[0].toUpperCase().trim();
  const { added } = addToWatchlist(symbol);
  if (!added) return reply(msg, `ℹ️ <code>${symbol}</code> sudah ada di watchlist.`);

  // Warmup klines for new symbol
  try {
    const { fetchKlines } = await import('../enrichment/binance.js');
    const k5m  = await fetchKlines(symbol, '5m',  50);
    const k15m = await fetchKlines(symbol, '15m', 50);
    const { klineCache } = await import('../signals/scanner.js').catch(() => ({}));
    // Reconnect WS to include new symbol
    reconnectWebSocket();
    await reply(msg, `✅ <code>${symbol}</code> ditambahkan ke watchlist 📌\nWebSocket reconnecting...`);
  } catch (err) {
    reconnectWebSocket();
    await reply(msg, `✅ <code>${symbol}</code> ditambahkan ke watchlist 📌`);
  }
}

async function handleUnwatch(msg, args) {
  if (!args[0]) return reply(msg, 'Usage: /unwatch &lt;SYMBOL&gt;\nContoh: /unwatch SOLUSDT');
  const symbol = args[0].toUpperCase().trim();
  const { removed } = removeFromWatchlist(symbol);
  if (!removed) return reply(msg, `ℹ️ <code>${symbol}</code> tidak ada di watchlist.`);
  reconnectWebSocket();
  await reply(msg, `🗑️ <code>${symbol}</code> dihapus dari watchlist.\nWebSocket reconnecting...`);
}

async function handleTopGainers(msg) {
  await reply(msg, '📡 Fetching top gainers dari Binance...');
  try {
    const after = await refreshTopGainers(false);
    const watchlist = getWatchlist();
    await reply(msg, [
      `✅ <b>Top Gainers Refreshed</b>`,
      `Watchlist sekarang: <b>${watchlist.length} symbols</b>`,
      `<code>${watchlist.join(', ')}</code>`,
    ].join('\n'));
    // Reconnect WS with updated list
    reconnectWebSocket();
  } catch (err) {
    await reply(msg, `❌ Gagal fetch top gainers: ${escapeHtml(err.message)}`);
  }
}

async function handleScan(msg) {
  await reply(msg, '🔍 Scanning signals...');
  const { scanSignals } = await import('../signals/scanner.js');
  await scanSignals();
  await reply(msg, '✅ Scan complete. Check for new candidates.');
}

async function handleDebug(msg, args) {
  const symbol = (args[0] || 'BTCUSDT').toUpperCase().trim();
  await reply(msg, `🔬 Diagnosing <code>${symbol}</code>...`);

  try {
    const { fetchKlines, fetchPremiumIndex } = await import('../enrichment/binance.js');
    const { detectMarketStructure } = await import('../signals/marketStructure.js');
    const { findRelevantOrderBlock } = await import('../signals/orderBlock.js');
    const { isPriceInFibZone } = await import('../signals/fibonacci.js');

    const k5m  = await fetchKlines(symbol, '5m',  50);
    const k15m = await fetchKlines(symbol, '15m', 50);

    let fundingRate = null;
    try {
      const p = await fetchPremiumIndex(symbol);
      fundingRate = Number(p.lastFundingRate || 0);
    } catch {}

    const currentPrice = k5m[k5m.length - 1].close;
    const ms = detectMarketStructure(k15m, 3, 3);

    const lines = [
      `🔬 <b>Debug: ${symbol}</b>`,
      `Price: <b>${fmtUsd(currentPrice)}</b>`,
      `Funding: <b>${fundingRate !== null ? (fundingRate * 100).toFixed(4) + '%' : 'N/A'}</b>`,
      ``,
      `📊 <b>Market Structure (15m)</b>`,
      `Trend: <b>${ms.trend}</b>`,
      `Swing Highs: <b>${ms.swingHighs.length}</b> | Swing Lows: <b>${ms.swingLows.length}</b>`,
    ];

    if (ms.trend === 'UPTREND') {
      lines.push(`Last HH: <b>${fmtUsd(ms.lastHH)}</b>`);
      lines.push(`Last HL: <b>${fmtUsd(ms.lastHL)}</b> ← SL anchor`);
    } else if (ms.trend === 'DOWNTREND') {
      lines.push(`Last LH: <b>${fmtUsd(ms.lastLH)}</b> ← SL anchor`);
      lines.push(`Last LL: <b>${fmtUsd(ms.lastLL)}</b>`);
    } else {
      lines.push(`⚠️ RANGING — no signal possible`);
    }

    if (ms.trend !== 'RANGING') {
      const direction = ms.trend === 'UPTREND' ? 'LONG' : 'SHORT';
      lines.push(``);
      lines.push(`🟦 <b>Order Block (5m) — ${direction}</b>`);

      const ob = findRelevantOrderBlock(k5m, direction, currentPrice);
      if (!ob) {
        lines.push(`❌ No valid OB found`);
      } else {
        lines.push(`OB High: <b>${fmtUsd(ob.obHigh)}</b> | OB Low: <b>${fmtUsd(ob.obLow)}</b>`);
        lines.push(`Impulse: <b>${ob.impulseSize.toFixed(2)}%</b>`);

        const swingHigh = ms.swingHighs[ms.swingHighs.length - 1]?.price;
        const swingLow  = ms.swingLows[ms.swingLows.length - 1]?.price;

        if (swingHigh && swingLow) {
          lines.push(``);
          lines.push(`📐 <b>Fibonacci</b>`);
          lines.push(`Swing: ${fmtUsd(swingLow)} → ${fmtUsd(swingHigh)}`);

          const fib = isPriceInFibZone(currentPrice, swingLow, swingHigh, direction);
          lines.push(`78.6% level: <b>${fmtUsd(fib.fib79Price)}</b>`);
          lines.push(`70.5% level: <b>${fmtUsd(fib.fib705Price)}</b>`);
          lines.push(`In fib zone: <b>${fib.inZone ? '✅' : '❌'}</b>`);

          // R:R estimate
          const entry = currentPrice;
          const slAnchor = direction === 'LONG' ? (ms.lastHL ?? swingLow) : (ms.lastLH ?? swingHigh);
          const slBuffer = slAnchor * 0.003;
          const sl = direction === 'LONG' ? slAnchor - slBuffer : slAnchor + slBuffer;
          const tp = direction === 'LONG' ? swingHigh : swingLow;
          const risk   = Math.abs(entry - sl);
          const reward = Math.abs(tp - entry);
          const rr = risk > 0 ? reward / risk : 0;

          lines.push(``);
          lines.push(`🎯 <b>Trade Estimate</b>`);
          lines.push(`Entry: <b>${fmtUsd(entry)}</b>`);
          lines.push(`SL: <b>${fmtUsd(sl)}</b> (${((sl - entry) / entry * 100).toFixed(2)}%)`);
          lines.push(`TP: <b>${fmtUsd(tp)}</b> (${((tp - entry) / entry * 100).toFixed(2)}%)`);
          lines.push(`R:R: <b>1:${rr.toFixed(2)}</b> ${rr >= 2 ? '✅' : '❌ (need ≥ 1:2)'}`);
        }
      }
    }

    await reply(msg, lines.filter(Boolean).join('\n'));
  } catch (err) {
    await reply(msg, `❌ Debug error: ${escapeHtml(err.message)}`);
  }
}

async function handleLesson(msg, args) {
  if (!args.length) return reply(msg, 'Usage: /lesson <text>');
  const lesson = args.join(' ');
  await addLesson(lesson);
  await reply(msg, `✅ Lesson added: <i>${escapeHtml(lesson)}</i>`);
}

async function handleLessons(msg) {
  const rows = await getActiveLessons(10);
  if (!rows.length) return reply(msg, '📚 No active lessons.');
  await reply(msg, `📚 <b>Active Lessons</b>\n${rows.map(r => `• [${r.id}] <i>${escapeHtml(r.lesson)}</i>`).join('\n')}`);
}

async function handleBalance(msg) {
  if (TRADING_MODE !== 'dry_run') {
    return reply(msg, '💰 Virtual balance hanya tersedia di mode <code>dry_run</code>.\nMode saat ini: <code>' + TRADING_MODE + '</code>');
  }

  try {
    const summary = await getBalanceSummary();
    const stats = await getVirtualBalanceStats();
    
    await reply(msg, [
      `💰 <b>Virtual Balance (Dry Run)</b>`,
      ``,
      `💵 Balance: <b>${summary.balance}</b>`,
      `💳 Available: <b>${summary.available}</b>`,
      `🔒 Margin Used: <b>${summary.margin_used}</b>`,
      `📊 Unrealized PnL: <b>${summary.unrealized_pnl}</b>`,
      `💎 Equity: <b>${summary.equity}</b>`,
      ``,
      `📈 <b>Performance</b>`,
      `🎯 Total Return: <b>${summary.total_return}</b>`,
      `🏆 Win Rate: <b>${summary.win_rate}</b> (${stats.winning_trades}W/${stats.losing_trades}L)`,
      `📉 Max Drawdown: <b>${summary.max_drawdown}</b>`,
      `🔢 Total Trades: <b>${summary.total_trades}</b>`,
    ].join('\n'));
  } catch (err) {
    await reply(msg, `❌ Error getting balance: ${escapeHtml(err.message)}`);
  }
}

async function handleResetBalance(msg, args) {
  if (TRADING_MODE !== 'dry_run') {
    return reply(msg, '💰 Virtual balance reset hanya tersedia di mode <code>dry_run</code>.');
  }

  const amount = args[0] ? parseFloat(args[0]) : 100;
  if (isNaN(amount) || amount <= 0) {
    return reply(msg, '❌ Invalid amount. Usage: /reset_balance [amount]\nContoh: /reset_balance 1000');
  }

  try {
    const balance = await resetVirtualBalance(amount);
    await reply(msg, [
      `🔄 <b>Virtual Balance Reset</b>`,
      ``,
      `💵 New Balance: <b>${balance.balance_usdt.toFixed(2)} USDT</b>`,
      `💳 Available: <b>${balance.available_balance.toFixed(2)} USDT</b>`,
      ``,
      `✅ Ready for new backtest session!`,
    ].join('\n'));
  } catch (err) {
    await reply(msg, `❌ Error resetting balance: ${escapeHtml(err.message)}`);
  }
}

async function handleBacktest(msg) {
  if (TRADING_MODE !== 'dry_run') {
    return reply(msg, '📊 Backtest summary hanya tersedia di mode <code>dry_run</code>.');
  }

  try {
    const stats = await getVirtualBalanceStats();
    const summary = await getBalanceSummary();
    
    // Get recent closed positions for additional stats
    const recentTrades = await recentClosedPositions(10);

    const avgWin = stats.winning_trades > 0 
      ? recentTrades.filter(t => t.pnl_usdt > 0).reduce((sum, t) => sum + Number(t.pnl_usdt), 0) / stats.winning_trades
      : 0;
      
    const avgLoss = stats.losing_trades > 0
      ? recentTrades.filter(t => t.pnl_usdt <= 0).reduce((sum, t) => sum + Number(t.pnl_usdt), 0) / stats.losing_trades
      : 0;

    const profitFactor = (avgWin * stats.winning_trades) / Math.abs(avgLoss * stats.losing_trades) || 0;

    await reply(msg, [
      `📊 <b>Backtest Performance Summary</b>`,
      ``,
      `💰 <b>Balance Overview</b>`,
      `Starting: <b>${stats.starting_balance.toFixed(2)} USDT</b>`,
      `Current: <b>${summary.balance}</b>`,
      `Peak: <b>${stats.peak_balance.toFixed(2)} USDT</b>`,
      `Total Return: <b>${summary.total_return}</b>`,
      ``,
      `📈 <b>Trading Statistics</b>`,
      `Total Trades: <b>${stats.total_trades}</b>`,
      `Win Rate: <b>${summary.win_rate}</b>`,
      `Wins: <b>${stats.winning_trades}</b> | Losses: <b>${stats.losing_trades}</b>`,
      ``,
      `💵 <b>PnL Analysis</b>`,
      `Avg Win: <b>+${avgWin.toFixed(2)} USDT</b>`,
      `Avg Loss: <b>${avgLoss.toFixed(2)} USDT</b>`,
      `Profit Factor: <b>${profitFactor.toFixed(2)}</b>`,
      `Max Drawdown: <b>${summary.max_drawdown}</b>`,
      ``,
      `📋 <b>Recent Trades</b>`,
      ...recentTrades.slice(0, 5).map(t => 
        `• ${t.symbol} ${t.direction} → ${Number(t.pnl_usdt) >= 0 ? '+' : ''}${Number(t.pnl_usdt).toFixed(2)} USDT (${t.exit_reason})`
      ),
    ].join('\n'));
  } catch (err) {
    await reply(msg, `❌ Error getting backtest summary: ${escapeHtml(err.message)}`);
  }
}

async function handleStats(msg, args) {
  const sub = (args[0] || '').toLowerCase();
  if (sub !== 'confidence') {
    return reply(msg, 'Usage: <code>/stats confidence</code> — bandingkan confidence LLM vs win rate aktual dari posisi yang sudah closed.');
  }

  try {
    const buckets = await confidenceCalibration();
    if (buckets.length === 0) {
      return reply(msg, '📊 Belum ada data cukup di <code>decision_outcomes</code> (posisi closed) untuk dianalisis.');
    }

    const lines = [`📊 <b>Confidence Calibration</b>`, ``];
    for (const b of buckets) {
      lines.push(
        `<b>${b.bucketLow}-${b.bucketHigh}%</b>: ${b.total} trade, win rate <b>${b.winRate.toFixed(1)}%</b>, ` +
        `avg PnL ${b.avgPnlUsdt >= 0 ? '+' : ''}${b.avgPnlUsdt.toFixed(2)} USDT`
      );
    }
    lines.push(``, `<i>Kalau confidence terkalibrasi baik, win rate tiap bucket harusnya dekat titik tengah rentangnya (mis. bucket 80-100% → win rate ~90%).</i>`);

    await reply(msg, lines.join('\n'));
  } catch (err) {
    await reply(msg, `❌ Error getting confidence stats: ${escapeHtml(err.message)}`);
  }
}

async function handleStrategySelect(query, id) {
  const all = allStrategyIds();
  if (!all.includes(id)) return;
  setActiveSetting('active_strategy', id);
  const strat = activeStrategy();
  await bot.sendMessage(query.message.chat.id, [
    `✅ Switched to <b>${id}</b>`,
    `Leverage: ${strat.leverage}x | TP: ${fmtPct(strat.tp_percent)} | SL: ${fmtPct(strat.sl_percent)}`,
  ].join('\n'), { parse_mode: 'HTML' });
}

async function handleIntentApprove(query, intentId) {
  const intent = getTradeIntent(intentId);
  if (!intent || intent.status !== 'pending_confirmation') {
    return bot.sendMessage(query.message.chat.id, '❌ Intent not found or already processed.', { parse_mode: 'HTML' });
  }
  updateTradeIntentStatus(intentId, 'approved');
  const { candidate, decision } = JSON.parse(intent.intent_json);
  try {
    const { orderId, liqPrice } = await executeFuturesBuy(candidate, decision);
    candidate.metrics.liqPrice = liqPrice;
    const positionId = createLivePosition(intent.candidate_id, candidate, decision, orderId);
    await sendPositionOpen(positionId);
    await bot.sendMessage(query.message.chat.id, `✅ Intent #${intentId} executed.`, { parse_mode: 'HTML' });
  } catch (err) {
    await bot.sendMessage(query.message.chat.id, `❌ Execution failed: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
}

async function handleIntentReject(query, intentId) {
  updateTradeIntentStatus(intentId, 'rejected');
  await bot.sendMessage(query.message.chat.id, `🚫 Intent #${intentId} rejected.`, { parse_mode: 'HTML' });
}
