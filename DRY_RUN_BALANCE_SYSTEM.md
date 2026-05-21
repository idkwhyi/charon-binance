# Dry Run Balance System - Virtual Balance untuk Backtesting

## Overview

Sistem virtual balance telah ditambahkan untuk mode `dry_run` yang memungkinkan backtesting yang akurat dengan tracking balance virtual. Sistem ini mensimulasikan trading dengan balance USDT virtual tanpa menggunakan dana real.

## Fitur Virtual Balance System

### 1. **Balance Tracking**
- **Starting Balance**: 1000 USDT (default, bisa diubah)
- **Available Balance**: Balance yang tersedia untuk trading
- **Margin Used**: Margin yang sedang digunakan untuk posisi terbuka
- **Unrealized PnL**: Profit/Loss dari posisi yang masih terbuka
- **Equity**: Total balance + unrealized PnL

### 2. **Performance Metrics**
- **Total Return**: Persentase return dari starting balance
- **Win Rate**: Persentase trade yang profit
- **Max Drawdown**: Drawdown maksimum dari peak balance
- **Profit Factor**: Ratio total profit vs total loss
- **Trade Statistics**: Total trades, wins, losses

### 3. **Risk Management**
- **Margin Check**: Cek balance sebelum membuka posisi
- **Position Sizing**: Berdasarkan `TRADE_AMOUNT_USDT` dari config
- **Balance Protection**: Tidak bisa open posisi jika balance tidak cukup

## Trading Modes Explained

### **DRY_RUN Mode** 🎯
- **Fungsi**: Simulasi trading dengan virtual balance
- **Balance**: Virtual USDT balance (default: 1000 USDT)
- **Execution**: Tidak ada order real ke Binance
- **PnL Calculation**: Berdasarkan pergerakan harga real-time
- **Use Case**: Backtesting, strategy testing, learning

**Keunggulan:**
- ✅ Risk-free testing
- ✅ Performance tracking lengkap
- ✅ Balance management realistis
- ✅ Cocok untuk backtesting

### **CONFIRM Mode** ⏸️
- **Fungsi**: Manual confirmation sebelum eksekusi
- **Balance**: Real balance di Binance
- **Execution**: Menunggu konfirmasi manual via Telegram
- **PnL Calculation**: Real trading results
- **Use Case**: Semi-automated trading dengan kontrol manual

**Keunggulan:**
- ✅ Control penuh atas setiap trade
- ✅ Review manual sebelum eksekusi
- ✅ Cocok untuk strategy validation

### **LIVE Mode** 🚀
- **Fungsi**: Fully automated trading
- **Balance**: Real balance di Binance
- **Execution**: Otomatis langsung ke market
- **PnL Calculation**: Real trading results
- **Use Case**: Production trading

**Keunggulan:**
- ✅ Fully automated
- ✅ Real-time execution
- ✅ Maximum efficiency

## Telegram Commands untuk Virtual Balance

### Balance Management
```
/balance              - Show virtual balance dan performance
/reset_balance [1000] - Reset balance ke amount tertentu
/backtest            - Show detailed backtest summary
```

### Trading Commands
```
/positions           - Show open positions
/pnl                - Show PnL summary
/strategy           - Switch trading strategy
```

## Database Schema

### Virtual Balance Table
```sql
CREATE TABLE virtual_balance (
    id SERIAL PRIMARY KEY,
    balance_usdt DECIMAL(20, 8) NOT NULL DEFAULT 1000.00,
    available_balance DECIMAL(20, 8) NOT NULL DEFAULT 1000.00,
    margin_used DECIMAL(20, 8) NOT NULL DEFAULT 0.00,
    unrealized_pnl DECIMAL(20, 8) NOT NULL DEFAULT 0.00,
    total_realized_pnl DECIMAL(20, 8) NOT NULL DEFAULT 0.00,
    total_trades INTEGER NOT NULL DEFAULT 0,
    winning_trades INTEGER NOT NULL DEFAULT 0,
    losing_trades INTEGER NOT NULL DEFAULT 0,
    max_drawdown_percent DECIMAL(10, 4) NOT NULL DEFAULT 0.00,
    peak_balance DECIMAL(20, 8) NOT NULL DEFAULT 1000.00,
    execution_mode VARCHAR(20) NOT NULL DEFAULT 'dry_run',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Configuration

### Environment Variables
```env
# Trading mode
TRADING_MODE=dry_run

# Trade amount per position
TRADE_AMOUNT_USDT=2

# PostgreSQL (recommended for production)
USE_POSTGRES=true
PG_DATABASE=endelif
```

## Workflow Virtual Balance

### 1. **Opening Position**
```javascript
// Check balance
if (!canOpenPosition(marginRequired)) {
  throw new Error('Insufficient virtual balance');
}

// Reserve margin
await reserveMargin(marginRequired);

// Create position
const positionId = await createDryRunPosition(candidateId, candidate, decision);
```

### 2. **Closing Position**
```javascript
// Calculate PnL
const pnlUsdt = calculatePnL(position, exitPrice);

// Release margin and update stats
await releaseMargin(marginUsed, pnlUsdt);

// Close position
await closePosition(positionId, exitPrice, reason, pnlPercent, pnlUsdt);
```

### 3. **Balance Updates**
- **Position Open**: `available_balance -= margin_used`
- **Position Close**: `available_balance += margin_used + pnl`
- **Statistics Update**: Win/loss count, drawdown, peak balance

## Example Usage

### 1. **Start Backtesting**
```bash
# Set mode to dry_run
TRADING_MODE=dry_run

# Start bot
npm start
```

### 2. **Monitor Performance**
```
/balance
💰 Virtual Balance (Dry Run)

💵 Balance: 1,045.50 USDT
💳 Available: 1,043.50 USDT  
🔒 Margin Used: 2.00 USDT
📊 Unrealized PnL: +12.30 USDT
💎 Equity: 1,057.80 USDT

📈 Performance
🎯 Total Return: +4.55%
🏆 Win Rate: 75.0% (6W/2L)
📉 Max Drawdown: 2.1%
🔢 Total Trades: 8
```

### 3. **Reset for New Test**
```
/reset_balance 1000
🔄 Virtual Balance Reset

💵 New Balance: 1000.00 USDT
💳 Available: 1000.00 USDT

✅ Ready for new backtest session!
```

## Best Practices

### 1. **Backtesting Strategy**
- Start dengan balance realistis (1000-5000 USDT)
- Test dengan different market conditions
- Monitor drawdown dan risk metrics
- Validate win rate dan profit factor

### 2. **Risk Management**
- Set appropriate `TRADE_AMOUNT_USDT`
- Monitor max drawdown (keep < 20%)
- Maintain win rate > 50%
- Target profit factor > 1.5

### 3. **Performance Analysis**
- Track performance over time
- Compare different strategies
- Analyze trade distribution
- Monitor equity curve

## Migration dari SQLite ke PostgreSQL

Virtual balance system mendukung both SQLite dan PostgreSQL:

- **SQLite**: Untuk development dan testing
- **PostgreSQL**: Untuk production dan advanced analytics

Set `USE_POSTGRES=true` untuk menggunakan PostgreSQL.

## Troubleshooting

### Common Issues

1. **"Insufficient virtual balance"**
   - Solution: Reset balance atau reduce trade amount

2. **"Position not found"**
   - Solution: Check database connection

3. **Balance tidak update**
   - Solution: Restart bot, check database

### Debug Commands
```
/debug BTCUSDT    - Diagnose signal issues
/positions        - Check open positions
/pnl             - Check PnL summary
```

## Kesimpulan

Virtual balance system memberikan:
- ✅ **Risk-free backtesting** dengan balance tracking akurat
- ✅ **Performance metrics** lengkap untuk strategy evaluation  
- ✅ **Realistic simulation** dengan margin management
- ✅ **Easy monitoring** via Telegram commands

Sistem ini memungkinkan testing strategy secara aman sebelum menggunakan dana real, dengan tracking performance yang comprehensive untuk analisis mendalam.