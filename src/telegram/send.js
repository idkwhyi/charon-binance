import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from '../config.js';
import { candidateSummary, positionSummary } from './format.js';
import { escapeHtml, dirEmoji, fmtUsd, fmtPct } from '../format.js';
import { db } from '../db/connection.js';

let bot = null;

export function getBot() {
  return bot;
}

export function initBot() {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
  return bot;
}

async function send(text, extra = {}) {
  if (!bot) return;
  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, text, { parse_mode: 'HTML', ...extra });
  } catch (err) {
    console.log(`[telegram] send failed: ${err.message}`);
  }
}

export async function sendTelegram(text) {
  return send(text);
}

export async function sendStartup(mode, watchlist) {
  await send([
    `🤖 <b>Charon Binance Futures started</b>`,
    `Mode: <code>${escapeHtml(mode)}</code>`,
    `Watching: <code>${escapeHtml(watchlist.join(', '))}</code>`,
  ].join('\n'));
}

export async function sendPositionOpen(positionId) {
  const row = db.prepare("SELECT * FROM positions WHERE id = ?").get(positionId);
  if (!row) return;
  await send([
    `✅ <b>Position Opened #${row.id}</b>`,
    `${dirEmoji(row.direction)} <b>${escapeHtml(row.symbol)}</b> ${row.direction} ${row.leverage}x`,
    `Entry: <b>${fmtUsd(row.entry_price)}</b>`,
    `Margin: <b>${fmtUsd(row.entry_usdt)}</b> USDT`,
    row.liq_price ? `Liq Price: <b>${fmtUsd(row.liq_price)}</b>` : null,
    `TP: <b>${fmtPct(row.tp_percent)}</b> | SL: <b>${fmtPct(row.sl_percent)}</b>`,
    `Mode: <code>${row.execution_mode}</code>`,
  ].filter(Boolean).join('\n'));
}

export async function sendPositionExit(position) {
  const pnl = Number(position.pnlPercent || 0);
  const emoji = pnl >= 0 ? '💰' : '💸';
  await send([
    `${emoji} <b>Position Closed #${position.id}</b>`,
    `${dirEmoji(position.direction)} <b>${escapeHtml(position.symbol)}</b> ${position.direction} ${position.leverage}x`,
    `Entry: <b>${fmtUsd(position.entry_price)}</b> → Exit: <b>${fmtUsd(position.exit_price || position.markPrice)}</b>`,
    `PnL: <b>${fmtPct(pnl)}</b> (${(position.pnlUsdt >= 0 ? '+' : '') + Number(position.pnlUsdt || 0).toFixed(2)} USDT)`,
    `Reason: <code>${escapeHtml(position.exitReason)}</code>`,
  ].join('\n'));
}

export async function sendTradeIntent(intentId, candidate, decision) {
  const dir = decision.direction;
  const text = [
    `⚡ <b>Trade Intent #${intentId} — Confirm?</b>`,
    candidateSummary(candidate, decision),
  ].join('\n');
  await send(text, {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Execute', callback_data: `intent_approve:${intentId}` },
        { text: '❌ Reject', callback_data: `intent_reject:${intentId}` },
      ]],
    },
  });
}
