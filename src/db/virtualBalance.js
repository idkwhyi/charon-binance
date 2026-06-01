/**
 * Virtual Balance Management for Dry Run Mode
 * Provides backtesting capabilities with virtual USDT balance
 */

import { pool } from './pg-connection.js';
import { db } from './connection.js';
import { now } from '../utils.js';

// Check if we're using PostgreSQL
const USE_POSTGRES = process.env.USE_POSTGRES === 'true';

/**
 * Execute query based on database type
 */
async function executeQuery(pgQuery, sqliteQuery, params = []) {
  if (USE_POSTGRES) {
    const result = await pool.query(pgQuery, params);
    return result.rows;
  } else {
    return db.prepare(sqliteQuery).all(...params);
  }
}

/**
 * Execute single row query
 */
async function executeQueryOne(pgQuery, sqliteQuery, params = []) {
  if (USE_POSTGRES) {
    const result = await pool.query(pgQuery, params);
    return result.rows[0] || null;
  } else {
    return db.prepare(sqliteQuery).get(...params);
  }
}

/**
 * Execute insert/update query
 */
async function executeRun(pgQuery, sqliteQuery, params = []) {
  if (USE_POSTGRES) {
    const result = await pool.query(pgQuery, params);
    return { lastInsertRowid: result.rows[0]?.id };
  } else {
    return db.prepare(sqliteQuery).run(...params);
  }
}

/**
 * Get current virtual balance for dry_run mode
 */
export async function getVirtualBalance() {
  const pgQuery = `
    SELECT * FROM virtual_balance 
    WHERE execution_mode = 'dry_run' 
    ORDER BY id DESC 
    LIMIT 1
  `;
  
  const sqliteQuery = `
    SELECT * FROM virtual_balance 
    WHERE execution_mode = 'dry_run' 
    ORDER BY id DESC 
    LIMIT 1
  `;
  
  const result = await executeQueryOne(pgQuery, sqliteQuery);
  
  if (!result) {
    // Initialize default balance if not exists
    return await initializeVirtualBalance();
  }
  
  // Convert PostgreSQL decimal strings to numbers
  if (USE_POSTGRES) {
    return {
      ...result,
      balance_usdt: Number(result.balance_usdt),
      available_balance: Number(result.available_balance),
      margin_used: Number(result.margin_used),
      unrealized_pnl: Number(result.unrealized_pnl),
      total_realized_pnl: Number(result.total_realized_pnl),
      max_drawdown_percent: Number(result.max_drawdown_percent),
      peak_balance: Number(result.peak_balance),
      starting_balance: Number(result.starting_balance || result.balance_usdt)
    };
  }
  
  return result;
}

/**
 * Initialize virtual balance with default values
 */
export async function initializeVirtualBalance(initialBalance = 1000) {
  const pgQuery = `
    INSERT INTO virtual_balance (
      balance_usdt, available_balance, starting_balance, execution_mode
    ) VALUES ($1, $2, $3, 'dry_run')
    RETURNING *
  `;
  
  const sqliteQuery = `
    INSERT INTO virtual_balance (
      balance_usdt, available_balance, starting_balance, execution_mode
    ) VALUES (?, ?, ?, 'dry_run')
  `;
  
  if (USE_POSTGRES) {
    const result = await pool.query(pgQuery, [initialBalance, initialBalance, initialBalance]);
    const row = result.rows[0];
    // Convert PostgreSQL decimal strings to numbers
    return {
      ...row,
      balance_usdt: Number(row.balance_usdt),
      available_balance: Number(row.available_balance),
      margin_used: Number(row.margin_used),
      unrealized_pnl: Number(row.unrealized_pnl),
      total_realized_pnl: Number(row.total_realized_pnl),
      max_drawdown_percent: Number(row.max_drawdown_percent),
      peak_balance: Number(row.peak_balance),
      starting_balance: Number(row.starting_balance)
    };
  } else {
    const result = db.prepare(sqliteQuery).run(initialBalance, initialBalance, initialBalance, 'dry_run');
    return db.prepare("SELECT * FROM virtual_balance WHERE id = ?").get(result.lastInsertRowid);
  }
}

/**
 * Reset virtual balance to initial amount
 */
export async function resetVirtualBalance(initialBalance = 1000) {
  const pgQuery = `
    UPDATE virtual_balance 
    SET 
      balance_usdt = $1,
      available_balance = $2,
      margin_used = 0,
      unrealized_pnl = 0,
      total_realized_pnl = 0,
      total_trades = 0,
      winning_trades = 0,
      losing_trades = 0,
      max_drawdown_percent = 0,
      peak_balance = $3,
      starting_balance = $4,
      updated_at = CURRENT_TIMESTAMP
    WHERE execution_mode = 'dry_run'
    RETURNING *
  `;
  
  const sqliteQuery = `
    UPDATE virtual_balance 
    SET 
      balance_usdt = ?,
      available_balance = ?,
      margin_used = 0,
      unrealized_pnl = 0,
      total_realized_pnl = 0,
      total_trades = 0,
      winning_trades = 0,
      losing_trades = 0,
      max_drawdown_percent = 0,
      peak_balance = ?,
      starting_balance = ?,
      updated_at = datetime('now')
    WHERE execution_mode = 'dry_run'
  `;
  
  if (USE_POSTGRES) {
    const result = await pool.query(pgQuery, [initialBalance, initialBalance, initialBalance, initialBalance]);
    if (result.rows.length > 0) {
      const row = result.rows[0];
      // Convert PostgreSQL decimal strings to numbers
      return {
        ...row,
        balance_usdt: Number(row.balance_usdt),
        available_balance: Number(row.available_balance),
        margin_used: Number(row.margin_used),
        unrealized_pnl: Number(row.unrealized_pnl),
        total_realized_pnl: Number(row.total_realized_pnl),
        max_drawdown_percent: Number(row.max_drawdown_percent),
        peak_balance: Number(row.peak_balance),
        starting_balance: Number(row.starting_balance)
      };
    }
  } else {
    db.prepare(sqliteQuery).run(initialBalance, initialBalance, initialBalance, initialBalance);
  }
  
  return await getVirtualBalance();
}

/**
 * Reserve margin for a new position
 */
export async function reserveMargin(marginAmount) {
  const balance = await getVirtualBalance();
  
  if (balance.available_balance < marginAmount) {
    throw new Error(`Insufficient virtual balance: ${balance.available_balance.toFixed(2)} USDT available, need ${marginAmount.toFixed(2)} USDT`);
  }
  
  const pgQuery = `
    UPDATE virtual_balance 
    SET 
      available_balance = available_balance - $1,
      margin_used = margin_used + $2,
      updated_at = CURRENT_TIMESTAMP
    WHERE execution_mode = 'dry_run'
  `;
  
  const sqliteQuery = `
    UPDATE virtual_balance 
    SET 
      available_balance = available_balance - ?,
      margin_used = margin_used + ?,
      updated_at = datetime('now')
    WHERE execution_mode = 'dry_run'
  `;
  
  if (USE_POSTGRES) {
    await pool.query(pgQuery, [marginAmount, marginAmount]);
  } else {
    db.prepare(sqliteQuery).run(marginAmount, marginAmount);
  }
  
  return await getVirtualBalance();
}

/**
 * Release margin when position is closed
 */
export async function releaseMargin(marginAmount, realizedPnl = 0) {
  const balance = await getVirtualBalance();
  const isWin = realizedPnl > 0;
  
  // Calculate new balance
  const newBalance = balance.balance_usdt + realizedPnl;
  const newAvailable = balance.available_balance + marginAmount + realizedPnl;
  const newMarginUsed = Math.max(0, balance.margin_used - marginAmount);
  
  // Update statistics
  const newTotalTrades = balance.total_trades + 1;
  const newWinningTrades = balance.winning_trades + (isWin ? 1 : 0);
  const newLosingTrades = balance.losing_trades + (isWin ? 0 : 1);
  const newTotalRealizedPnl = balance.total_realized_pnl + realizedPnl;
  
  // Update peak balance
  const newPeakBalance = Math.max(balance.peak_balance, newBalance);
  
  // Calculate drawdown
  const currentDrawdown = ((newPeakBalance - newBalance) / newPeakBalance) * 100;
  const newMaxDrawdown = Math.max(balance.max_drawdown_percent, currentDrawdown);
  
  const pgQuery = `
    UPDATE virtual_balance 
    SET 
      balance_usdt = $1,
      available_balance = $2,
      margin_used = $3,
      total_realized_pnl = $4,
      total_trades = $5,
      winning_trades = $6,
      losing_trades = $7,
      max_drawdown_percent = $8,
      peak_balance = $9,
      updated_at = CURRENT_TIMESTAMP
    WHERE execution_mode = 'dry_run'
  `;
  
  const sqliteQuery = `
    UPDATE virtual_balance 
    SET 
      balance_usdt = ?,
      available_balance = ?,
      margin_used = ?,
      total_realized_pnl = ?,
      total_trades = ?,
      winning_trades = ?,
      losing_trades = ?,
      max_drawdown_percent = ?,
      peak_balance = ?,
      updated_at = datetime('now')
    WHERE execution_mode = 'dry_run'
  `;
  
  const params = [
    newBalance,
    newAvailable, 
    newMarginUsed,
    newTotalRealizedPnl,
    newTotalTrades,
    newWinningTrades,
    newLosingTrades,
    newMaxDrawdown,
    newPeakBalance
  ];
  
  if (USE_POSTGRES) {
    await pool.query(pgQuery, params);
  } else {
    db.prepare(sqliteQuery).run(...params);
  }
  
  return await getVirtualBalance();
}

/**
 * Update unrealized PnL for open positions
 */
export async function updateUnrealizedPnl(totalUnrealizedPnl) {
  const pgQuery = `
    UPDATE virtual_balance 
    SET 
      unrealized_pnl = $1,
      updated_at = CURRENT_TIMESTAMP
    WHERE execution_mode = 'dry_run'
  `;
  
  const sqliteQuery = `
    UPDATE virtual_balance 
    SET 
      unrealized_pnl = ?,
      updated_at = datetime('now')
    WHERE execution_mode = 'dry_run'
  `;
  
  if (USE_POSTGRES) {
    await pool.query(pgQuery, [totalUnrealizedPnl]);
  } else {
    db.prepare(sqliteQuery).run(totalUnrealizedPnl);
  }
  
  return await getVirtualBalance();
}

/**
 * Get virtual balance statistics for reporting
 */
export async function getVirtualBalanceStats() {
  const balance = await getVirtualBalance();
  
  // Ensure numeric values
  const balanceUsdt = Number(balance.balance_usdt || 0);
  const totalTrades = Number(balance.total_trades || 0);
  const winningTrades = Number(balance.winning_trades || 0);
  const totalRealizedPnl = Number(balance.total_realized_pnl || 0);
  const unrealizedPnl = Number(balance.unrealized_pnl || 0);
  const maxDrawdownPercent = Number(balance.max_drawdown_percent || 0);
  const peakBalance = Number(balance.peak_balance || 1000);
  const startingBalance = Number(balance.starting_balance || balance.balance_usdt || 1000);
  
  const winRate = totalTrades > 0 
    ? (winningTrades / totalTrades * 100)
    : 0;
    
  const avgWin = winningTrades > 0
    ? (totalRealizedPnl / winningTrades)
    : 0;
    
  const avgLoss = (totalTrades - winningTrades) > 0
    ? (totalRealizedPnl / (totalTrades - winningTrades))
    : 0;
    
  // Calculate total return based on actual starting balance
  const totalReturn = startingBalance > 0 
    ? ((balanceUsdt - startingBalance) / startingBalance * 100)
    : 0;
  
  return {
    ...balance,
    balance_usdt: balanceUsdt,
    starting_balance: startingBalance,
    winRate: winRate,
    avgWin: avgWin,
    avgLoss: avgLoss,
    totalReturn: totalReturn,
    equity: balanceUsdt + unrealizedPnl
  };
}

/**
 * Check if we can open a new position with given margin
 */
export async function canOpenPosition(marginRequired) {
  const balance = await getVirtualBalance();
  return balance.available_balance >= marginRequired;
}

/**
 * Get formatted balance summary for display
 */
export async function getBalanceSummary() {
  const stats = await getVirtualBalanceStats();
  
  // Ensure numeric values
  const balance = Number(stats.balance_usdt || 0);
  const available = Number(stats.available_balance || 0);
  const marginUsed = Number(stats.margin_used || 0);
  const unrealizedPnl = Number(stats.unrealized_pnl || 0);
  const equity = Number(stats.equity || 0);
  const totalReturn = Number(stats.totalReturn || 0);
  const winRate = Number(stats.winRate || 0);
  const maxDrawdown = Number(stats.max_drawdown_percent || 0);
  
  return {
    balance: `${balance.toFixed(2)} USDT`,
    available: `${available.toFixed(2)} USDT`,
    margin_used: `${marginUsed.toFixed(2)} USDT`,
    unrealized_pnl: `${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)} USDT`,
    equity: `${equity.toFixed(2)} USDT`,
    total_return: `${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`,
    win_rate: `${winRate.toFixed(1)}%`,
    total_trades: stats.total_trades || 0,
    max_drawdown: `${maxDrawdown.toFixed(2)}%`
  };
}