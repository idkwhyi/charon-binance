# Database Tables Documentation

## Overview
Project ini menggunakan **11 tables** untuk mengelola trading bot operations. Berikut adalah penjelasan lengkap fungsi dan status penggunaan masing-masing table.

---

## 📊 Core Trading Tables

### 1. **candidates** ✅ AKTIF DIGUNAKAN
**Fungsi**: Menyimpan signal trading yang terdeteksi dari technical analysis

**Kolom Utama**:
- `symbol`: Trading pair (e.g., BTCUSDT)
- `signal_type`: Jenis signal (e.g., extreme_ob)
- `direction`: LONG atau SHORT
- `status`: candidate, processed, rejected
- `candidate_json`: Data lengkap signal (JSONB)
- `filters_json`: Filter yang digunakan (JSONB)

**Digunakan Di**:
- `src/db/candidates.js` - CRUD operations
- `src/signals/scanner.js` - Create new candidates
- `src/pipeline/orchestrator.js` - Process candidates

**Status**: ✅ **AKTIF** - Digunakan untuk menyimpan semua signal yang terdeteksi

---

### 2. **positions** ✅ AKTIF DIGUNAKAN
**Fungsi**: Menyimpan semua trading positions (dry_run, confirm, live)

**Kolom Utama**:
- `symbol`: Trading pair
- `direction`: LONG/SHORT
- `execution_mode`: dry_run, confirm, atau live
- `entry_price`, `exit_price`: Harga entry dan exit
- `tp_percent`, `sl_percent`: Take profit dan stop loss
- `pnl_percent`, `pnl_usdt`: Profit/Loss
- `status`: open atau closed
- `trailing_enabled`: Trailing stop feature

**Digunakan Di**:
- `src/db/positions.js` - CRUD operations
- `src/execution/positions.js` - Monitor dan close positions
- `src/pipeline/orchestrator.js` - Create positions
- Telegram commands: `/positions`, `/pnl`

**Status**: ✅ **AKTIF** - Core table untuk tracking semua positions

---

### 3. **trades** ✅ AKTIF DIGUNAKAN
**Fungsi**: Log semua trade executions (audit trail)

**Kolom Utama**:
- `position_id`: Reference ke positions table
- `side`: BUY atau SELL
- `price`: Execution price
- `pnl_percent`, `pnl_usdt`: PnL dari trade
- `reason`: Alasan trade (TP hit, SL hit, manual, etc.)
- `payload_json`: Data tambahan (JSONB)

**Digunakan Di**:
- `src/db/positions.js` - `logTrade()` function
- `src/execution/positions.js` - Log saat close position

**Status**: ✅ **AKTIF** - Digunakan untuk audit trail dan analytics

---

## 🤖 LLM Decision Tables

### 4. **decisions** ⚠️ PARTIALLY USED
**Fungsi**: Menyimpan keputusan LLM untuk individual candidates

**Kolom Utama**:
- `candidate_id`: Reference ke candidates
- `verdict`: approve, reject, skip
- `confidence`: Confidence level (0-100)
- `reason`: Alasan keputusan
- `risks_json`: Risk analysis (JSONB)
- `tp_percent`, `sl_percent`: Suggested TP/SL

**Digunakan Di**:
- `src/db/decisions.js` - `storeDecision()` function
- `src/pipeline/llm.js` - LLM decision making

**Status**: ⚠️ **PARTIALLY USED** - Hanya digunakan jika `use_llm: true` di strategy config

**Note**: Strategy "extreme_ob" saat ini menggunakan `use_llm: false`, jadi table ini jarang digunakan

---

### 5. **batch_decisions** ⚠️ PARTIALLY USED
**Fungsi**: Menyimpan keputusan LLM untuk batch evaluation (multiple candidates)

**Kolom Utama**:
- `trigger_id`: ID candidate yang trigger batch
- `verdict`: Hasil batch decision
- `selected_id`: Candidate yang dipilih
- `confidence`: Confidence level
- `raw_json`: Full LLM response (JSONB)

**Digunakan Di**:
- `src/db/decisions.js` - `storeBatchDecision()` function
- `src/pipeline/llm.js` - Batch LLM evaluation

**Status**: ⚠️ **PARTIALLY USED** - Hanya untuk LLM batch mode

---

## 🎯 Trading Mode Tables

### 6. **trade_intents** ✅ AKTIF (CONFIRM MODE)
**Fungsi**: Menyimpan trade intents untuk manual confirmation (confirm mode)

**Kolom Utama**:
- `candidate_id`: Reference ke candidates
- `intent_json`: Full trade intent data (JSONB)
- `status`: pending, approved, rejected

**Digunakan Di**:
- `src/db/decisions.js` - `createTradeIntent()`, `getTradeIntent()`
- `src/pipeline/orchestrator.js` - Create intent di confirm mode
- `src/telegram/commands.js` - Approve/reject via Telegram

**Status**: ✅ **AKTIF** - Digunakan saat `TRADING_MODE=confirm`

**Workflow**:
1. Bot detect signal → Create trade_intent
2. Send Telegram notification dengan approve/reject buttons
3. User approve → Execute trade
4. User reject → Cancel intent

---

## ⚙️ Configuration Tables

### 7. **strategy_config** ✅ AKTIF DIGUNAKAN
**Fungsi**: Menyimpan konfigurasi strategies (key-value store)

**Kolom Utama**:
- `key`: Config key (e.g., "strategy:extreme_ob", "active_strategy")
- `value`: Config value (JSONB)

**Digunakan Di**:
- `src/db/settings.js` - Get/set strategy configs
- `src/pipeline/orchestrator.js` - Load active strategy
- Telegram commands: `/strategy`, `/stratset`

**Status**: ✅ **AKTIF** - Core configuration system

**Strategies Tersedia**:
- `extreme_ob` - Extreme Order Block strategy (AKTIF)
- `scalp` - Scalping strategy
- `swing` - Swing trading strategy
- `funding_fade` - Funding rate fade strategy
- `degen` - High leverage strategy

---

### 8. **watchlist** ✅ AKTIF DIGUNAKAN
**Fungsi**: Daftar symbols yang di-monitor bot

**Kolom Utama**:
- `symbol`: Trading pair (UNIQUE)
- `enabled`: Active atau tidak
- `added_at_ms`: Timestamp ditambahkan

**Digunakan Di**:
- `src/db/watchlist.js` - CRUD operations
- `src/enrichment/topGainers.js` - Auto-update dari top gainers
- `src/signals/scanner.js` - Scan signals untuk watchlist
- Telegram commands: `/watchlist`, `/watch`, `/unwatch`

**Status**: ✅ **AKTIF** - Core feature untuk symbol monitoring

**Features**:
- Manual add/remove via Telegram
- Auto-update dari top gainers (setiap 5 menit)
- Pinned symbols (manual) vs auto symbols (top gainers)

---

### 9. **watch_alerts** ✅ AKTIF DIGUNAKAN
**Fungsi**: Track watch alerts untuk prevent duplicate notifications

**Kolom Utama**:
- `symbol`: Trading pair
- `direction`: LONG/SHORT
- `signal_type`: Jenis signal
- `ob_high`, `ob_low`: Order block zone
- `last_sent_at_ms`: Timestamp last alert

**Digunakan Di**:
- `src/signals/scanner.js` - Check dan update watch alerts
- Prevent duplicate alerts untuk same signal

**Status**: ✅ **AKTIF** - Mencegah spam notifications

**Deduplication Key**: `symbol:direction:signal_type` + OB zone

---

## 💰 Backtesting Tables

### 10. **virtual_balance** ✅ AKTIF DIGUNAKAN
**Fungsi**: Track virtual balance untuk dry_run mode backtesting

**Kolom Utama**:
- `balance_usdt`: Current balance
- `available_balance`: Available untuk trading
- `margin_used`: Margin yang sedang digunakan
- `unrealized_pnl`: PnL dari open positions
- `total_realized_pnl`: Total PnL dari closed positions
- `total_trades`: Total trade count
- `winning_trades`, `losing_trades`: Win/loss count
- `max_drawdown_percent`: Max drawdown
- `peak_balance`: Peak balance achieved
- `starting_balance`: Starting balance (untuk return calculation)

**Digunakan Di**:
- `src/db/virtualBalance.js` - Balance management
- `src/db/positions.js` - Reserve/release margin
- Telegram commands: `/balance`, `/reset_balance`, `/backtest`

**Status**: ✅ **AKTIF** - Core feature untuk backtesting

**Features**:
- Automatic margin reservation saat open position
- Automatic margin release saat close position
- Performance metrics tracking
- Drawdown calculation

---

## 📚 Learning Tables

### 11. **learning_lessons** ⚠️ PARTIALLY USED
**Fungsi**: Menyimpan learning lessons untuk LLM context

**Kolom Utama**:
- `lesson`: Text lesson
- `status`: active atau archived
- `created_at_ms`: Timestamp

**Digunakan Di**:
- `src/pipeline/llm.js` - Include lessons di LLM prompt
- Telegram commands: `/lesson`, `/lessons`

**Status**: ⚠️ **PARTIALLY USED** - Hanya digunakan jika LLM enabled

**Use Case**: User bisa add lessons via Telegram yang akan digunakan LLM untuk improve decisions

---

## 📈 Database Views (PostgreSQL Only)

### **v_open_positions** ✅ AVAILABLE
**Fungsi**: View untuk quick access ke open positions dengan enriched data

**Columns**:
- All position columns
- `signal_type` dari candidates
- `current_price` dari candidate_json
- `hours_open` - Berapa lama position sudah open

**Status**: ✅ **AVAILABLE** - Ready untuk analytics

---

### **v_pnl_summary** ✅ AVAILABLE
**Fungsi**: Aggregated PnL statistics

**Columns**:
- `total_positions`: Total positions
- `wins`, `losses`: Win/loss count
- `win_rate_percent`: Win rate
- `total_pnl_usdt`: Total PnL
- `avg_win_usdt`, `avg_loss_usdt`: Average win/loss
- `open_count`: Open positions count

**Status**: ✅ **AVAILABLE** - Ready untuk analytics

---

### **v_recent_signals** ✅ AVAILABLE
**Fungsi**: Recent signals dengan entry confirmation data

**Columns**:
- Basic candidate info
- `entry_price`, `stop_loss`, `take_profit`
- `entry_confirmed`: Entry confirmation status
- `confirmation_score`: ICT confirmation score

**Status**: ✅ **AVAILABLE** - Ready untuk monitoring

---

## 📊 Table Usage Summary

| Table | Status | Usage Frequency | Primary Use Case |
|-------|--------|----------------|------------------|
| **candidates** | ✅ AKTIF | High | Signal detection & storage |
| **positions** | ✅ AKTIF | High | Position tracking (all modes) |
| **trades** | ✅ AKTIF | High | Trade audit trail |
| **decisions** | ⚠️ PARTIAL | Low | LLM decisions (if enabled) |
| **batch_decisions** | ⚠️ PARTIAL | Low | LLM batch mode (if enabled) |
| **trade_intents** | ✅ AKTIF | Medium | Confirm mode workflow |
| **strategy_config** | ✅ AKTIF | High | Strategy configuration |
| **watchlist** | ✅ AKTIF | High | Symbol monitoring |
| **watch_alerts** | ✅ AKTIF | High | Duplicate alert prevention |
| **virtual_balance** | ✅ AKTIF | High | Dry run backtesting |
| **learning_lessons** | ⚠️ PARTIAL | Low | LLM learning (if enabled) |

---

## 🔄 Data Flow

### **Signal Detection → Position Opening**
```
1. scanner.js detects signal
2. INSERT INTO candidates
3. orchestrator.js processes candidate
4. If LLM enabled: INSERT INTO decisions/batch_decisions
5. If confirm mode: INSERT INTO trade_intents
6. If approved: INSERT INTO positions
7. Reserve margin: UPDATE virtual_balance (dry_run mode)
```

### **Position Monitoring → Closing**
```
1. positions.js monitors open positions
2. Check TP/SL conditions
3. Close position: UPDATE positions
4. INSERT INTO trades (audit log)
5. Release margin: UPDATE virtual_balance (dry_run mode)
```

### **Watchlist Management**
```
1. topGainers.js fetches top gainers
2. UPDATE watchlist (auto symbols)
3. User adds symbol: INSERT INTO watchlist (pinned)
4. scanner.js scans watchlist symbols
5. INSERT INTO watch_alerts (prevent duplicates)
```

---

## 💡 Recommendations

### **Currently Active (Must Keep)**
- ✅ candidates
- ✅ positions
- ✅ trades
- ✅ strategy_config
- ✅ watchlist
- ✅ watch_alerts
- ✅ virtual_balance

### **Conditional (Keep if Using LLM)**
- ⚠️ decisions
- ⚠️ batch_decisions
- ⚠️ learning_lessons

### **Mode-Specific (Keep if Using Confirm Mode)**
- ✅ trade_intents

### **Optimization Opportunities**
1. **Add indexes** untuk frequently queried columns
2. **Partition** positions table by execution_mode untuk better performance
3. **Archive old data** dari candidates dan decisions tables
4. **Add materialized views** untuk complex analytics queries

---

## 🎯 Conclusion

**Total Tables**: 11 tables + 3 views

**Active Usage**:
- **8 tables** actively used in current setup
- **3 tables** conditionally used (LLM features)
- **3 views** available for analytics

**Database Health**: ✅ **GOOD**
- Well-structured schema
- Proper indexes
- Foreign key constraints
- Audit trail support
- Flexible JSONB columns for extensibility

Semua tables memiliki fungsi yang jelas dan digunakan sesuai dengan trading mode yang aktif.