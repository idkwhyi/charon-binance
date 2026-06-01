#!/usr/bin/env node
/**
 * View Mock Trade Performance
 * Script untuk melihat performa mock trading dari database
 */

import { initDb, db } from './src/db/connection.js';
import { initPgDb, pool } from './src/db/pg-connection.js';
import { getVirtualBalanceStats, getBalanceSummary } from './src/db/virtualBalance.js';

const USE_POSTGRES = process.env.USE_POSTGRES === 'true';

async function viewPerformance() {
  try {
    // Initialize databases
    initDb();
    if (USE_POSTGRES) {
      await initPgDb();
    }

    console.log('═══════════════════════════════════════════════════════════');
    console.log('           📊 MOCK TRADE PERFORMANCE REPORT');
    console.log('═══════════════════════════════════════════════════════════\n');

    // 1. Virtual Balance Summary
    const stats = await getVirtualBalanceStats();
    const summary = await getBalanceSummary();

    console.log('💰 VIRTUAL BALANCE');
    console.log('─────────────────────────────────────────────────────────');
    console.log(`Starting Balance:    ${stats.starting_balance.toFixed(2)} USDT`);
    console.log(`Current Balance:     ${summary.balance}`);
    console.log(`Available:           ${summary.available}`);
    console.log(`Margin Used:         ${summary.margin_used}`);
    console.log(`Unrealized PnL:      ${summary.unrealized_pnl}`);
    console.log(`Equity:              ${summary.equity}`);
    console.log('');

    // 2. Performance Metrics
    console.log('📈 PERFORMANCE METRICS');
    console.log('─────────────────────────────────────────────────────────');
    console.log(`Total Return:        ${summary.total_return}`);
    console.log(`Win Rate:            ${summary.win_rate}`);
    console.log(`Total Trades:        ${summary.total_trades}`);
    console.log(`Wins / Losses:       ${stats.winning_trades}W / ${stats.losing_trades}L`);
    console.log(`Max Drawdown:        ${summary.max_drawdown}`);
    console.log(`Peak Balance:        ${stats.peak_balance.toFixed(2)} USDT`);
    console.log('');

    // 3. Open Positions
    const openPositions = db.prepare(`
      SELECT id, symbol, direction, leverage, entry_price, entry_usdt, 
             tp_percent, sl_percent, opened_at_ms, strategy_id
      FROM positions 
      WHERE execution_mode = 'dry_run' AND status = 'open'
      ORDER BY opened_at_ms DESC
    `).all();

    console.log(`📋 OPEN POSITIONS (${openPositions.length})`);
    console.log('─────────────────────────────────────────────────────────');
    if (openPositions.length === 0) {
      console.log('No open positions');
    } else {
      openPositions.forEach(p => {
        const hoursOpen = ((Date.now() - p.opened_at_ms) / (1000 * 60 * 60)).toFixed(1);
        console.log(`#${p.id} ${p.symbol} ${p.direction} ${p.leverage}x`);
        console.log(`   Entry: $${p.entry_price} | Margin: ${p.entry_usdt} USDT`);
        console.log(`   TP: ${p.tp_percent > 0 ? '+' : ''}${p.tp_percent}% | SL: ${p.sl_percent}%`);
        console.log(`   Opened: ${hoursOpen}h ago | Strategy: ${p.strategy_id}`);
        console.log('');
      });
    }

    // 4. Closed Positions (Last 10)
    const closedPositions = db.prepare(`
      SELECT id, symbol, direction, leverage, entry_price, exit_price,
             pnl_percent, pnl_usdt, exit_reason, opened_at_ms, closed_at_ms
      FROM positions 
      WHERE execution_mode = 'dry_run' AND status = 'closed'
      ORDER BY closed_at_ms DESC
      LIMIT 10
    `).all();

    console.log(`📜 RECENT CLOSED POSITIONS (Last ${Math.min(10, closedPositions.length)})`);
    console.log('─────────────────────────────────────────────────────────');
    if (closedPositions.length === 0) {
      console.log('No closed positions yet');
    } else {
      closedPositions.forEach(p => {
        const holdTime = ((p.closed_at_ms - p.opened_at_ms) / (1000 * 60 * 60)).toFixed(1);
        const pnlSign = p.pnl_usdt >= 0 ? '+' : '';
        const emoji = p.pnl_usdt >= 0 ? '✅' : '❌';
        console.log(`${emoji} #${p.id} ${p.symbol} ${p.direction} ${p.leverage}x`);
        console.log(`   Entry: $${p.entry_price} → Exit: $${p.exit_price}`);
        console.log(`   PnL: ${pnlSign}${p.pnl_percent.toFixed(2)}% (${pnlSign}${p.pnl_usdt.toFixed(2)} USDT)`);
        console.log(`   Reason: ${p.exit_reason} | Hold: ${holdTime}h`);
        console.log('');
      });
    }

    // 5. PnL Analysis
    if (closedPositions.length > 0) {
      const wins = closedPositions.filter(p => p.pnl_usdt > 0);
      const losses = closedPositions.filter(p => p.pnl_usdt <= 0);
      
      const avgWin = wins.length > 0 
        ? wins.reduce((sum, p) => sum + p.pnl_usdt, 0) / wins.length 
        : 0;
      const avgLoss = losses.length > 0
        ? losses.reduce((sum, p) => sum + p.pnl_usdt, 0) / losses.length
        : 0;
      
      const totalWinAmount = wins.reduce((sum, p) => sum + p.pnl_usdt, 0);
      const totalLossAmount = Math.abs(losses.reduce((sum, p) => sum + p.pnl_usdt, 0));
      const profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : 0;

      console.log('💵 PNL ANALYSIS');
      console.log('─────────────────────────────────────────────────────────');
      console.log(`Average Win:         +${avgWin.toFixed(2)} USDT`);
      console.log(`Average Loss:        ${avgLoss.toFixed(2)} USDT`);
      console.log(`Total Win Amount:    +${totalWinAmount.toFixed(2)} USDT`);
      console.log(`Total Loss Amount:   -${totalLossAmount.toFixed(2)} USDT`);
      console.log(`Profit Factor:       ${profitFactor.toFixed(2)}`);
      console.log('');
    }

    // 6. Strategy Performance
    const strategyPerf = db.prepare(`
      SELECT 
        strategy_id,
        COUNT(*) as total,
        SUM(CASE WHEN pnl_usdt > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl_usdt <= 0 THEN 1 ELSE 0 END) as losses,
        SUM(pnl_usdt) as total_pnl,
        AVG(pnl_usdt) as avg_pnl
      FROM positions
      WHERE execution_mode = 'dry_run' AND status = 'closed'
      GROUP BY strategy_id
      ORDER BY total_pnl DESC
    `).all();

    if (strategyPerf.length > 0) {
      console.log('🎯 STRATEGY PERFORMANCE');
      console.log('─────────────────────────────────────────────────────────');
      strategyPerf.forEach(s => {
        const winRate = s.total > 0 ? (s.wins / s.total * 100).toFixed(1) : 0;
        console.log(`${s.strategy_id || 'unknown'}`);
        console.log(`   Trades: ${s.total} (${s.wins}W/${s.losses}L) | Win Rate: ${winRate}%`);
        console.log(`   Total PnL: ${s.total_pnl >= 0 ? '+' : ''}${s.total_pnl.toFixed(2)} USDT`);
        console.log(`   Avg PnL: ${s.avg_pnl >= 0 ? '+' : ''}${s.avg_pnl.toFixed(2)} USDT`);
        console.log('');
      });
    }

    console.log('═══════════════════════════════════════════════════════════');
    console.log('                    END OF REPORT');
    console.log('═══════════════════════════════════════════════════════════');

    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

viewPerformance();
