/**
 * Virtual Balance Management for Dry Run Mode
 * Provides backtesting capabilities with virtual USDT balance
 */

import { query as pgQuery } from './pg-connection.js';
import { now } from '../utils.js';

/**
 * Get current virtual balance for dry_run mode
 */
export async function getVirtualBalance() {
  try {
    const result = await pgQuery(
      "SELECT * FROM virtual_balance WHERE execution_mode = 'dry_run' ORDER BY id DESC LIMIT 1"
    );
    
    if (result.rows.length === 0) {
      return await initializeVirtualBalance();
    }
    
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
      starting_balance: Number(row.starting_balance || row.balance_usdt)
    };
  } catch (err) {
    console.error('[virtualBalance] getVirtualBalance failed:', err.message);
    // Return default fallback
    return {
      id: 0,
      balance_usdt: 1000,
      available_balance: 1000,
      margin_used: 0,
      unrealized_pnl: 0,
      total_realized_pnl: 0,
      total_trades: 0,
      winning_trades: 0,
      losing_trades: 0,
      max_drawdown_percent: 0,
      peak_balance: 1000,
      starting_balance: 1000,
      execution_mode: 'dry_run'
    };
  }
}

/**
 * Initialize virtual balance with default values
 */
export async function initializeVirtualBalance(initialBalance = 1000) {
  try {
    const result = await pgQuery(
      `INSERT INTO virtual_balance (
        balance_usdt, available_balance, starting_balance, execution_mode
      ) VALUES ($1, $2, $3, 'dry_run')
      RETURNING *`,
      [initialBalance, initialBalance, initialBalance]
    );
    
    if (result.rows.length === 0) return null;
    
    const row = result.rows[0];
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
  } catch (err) {
    console.error('[virtualBalance] initializeVirtualBalance failed:', err.message);
    return null;
  }
}

/**
 * Reset virtual balance to initial amount
 */
export async function resetVirtualBalance(initialBalance = 1000) {
  try {
    const result = await pgQuery(
      `UPDATE virtual_balance 
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
      RETURNING *`,
      [initialBalance, initialBalance, initialBalance, initialBalance]
    );
    
    if (result.rows.length === 0) return null;
    
    const row = result.rows[0];
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
  } catch (err) {
    console.error('[virtualBalance] resetVirtualBalance failed:', err.message);
    return null;
  }
}

/**
 * Reserve margin for a new position
 */
export async function reserveMargin(marginAmount) {
  try {
    const balance = await getVirtualBalance();
    
    if (balance.available_balance < marginAmount) {
      throw new Error(`Insufficient virtual balance: ${balance.available_balance.toFixed(2)} USDT available, need ${marginAmount.toFixed(2)} USDT`);
    }
    
    await pgQuery(
      `UPDATE virtual_balance 
      SET 
        available_balance = available_balance - $1,
        margin_used = margin_used + $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE execution_mode = 'dry_run'`,
      [marginAmount, marginAmount]
    );
    
    return await getVirtualBalance();
  } catch (err) {
    console.error('[virtualBalance] reserveMargin failed:', err.message);
    throw err;
  }
}

/**
 * Release margin when position is closed
 */
export async function releaseMargin(marginAmount, realizedPnl = 0) {
  try {
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
    
    await pgQuery(
      `UPDATE virtual_balance 
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
      WHERE execution_mode = 'dry_run'`,
      [
        newBalance,
        newAvailable, 
        newMarginUsed,
        newTotalRealizedPnl,
        newTotalTrades,
        newWinningTrades,
        newLosingTrades,
        newMaxDrawdown,
        newPeakBalance
      ]
    );
    
    return await getVirtualBalance();
  } catch (err) {
    console.error('[virtualBalance] releaseMargin failed:', err.message);
    throw err;
  }
}

/**
 * Update unrealized PnL for open positions
 */
export async function updateUnrealizedPnl(totalUnrealizedPnl) {
  try {
    await pgQuery(
      `UPDATE virtual_balance 
      SET 
        unrealized_pnl = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE execution_mode = 'dry_run'`,
      [totalUnrealizedPnl]
    );
    
    return await getVirtualBalance();
  } catch (err) {
    console.error('[virtualBalance] updateUnrealizedPnl failed:', err.message);
    return null;
  }
}

/**
 * Get virtual balance statistics for reporting
 */
export async function getVirtualBalanceStats() {
  try {
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
  } catch (err) {
    console.error('[virtualBalance] getVirtualBalanceStats failed:', err.message);
    return {};
  }
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