# 🧪 Testing Checklist - Multi-Timeframe Upgrade

## ✅ Pre-Start Checks

- [ ] Backup database: `cp charon-binance.sqlite charon-binance.sqlite.backup`
- [ ] Check .env file exists and configured
- [ ] Node modules installed: `npm install`
- [ ] Git commit current changes (optional)

## 🚀 Startup Tests

### 1. Bot Startup
```bash
npm start
```

**Expected Output:**
```
[scanner] warming up klines for X symbols (1h + 15m)...
[scanner] warmup done
[scanner] WebSocket connected (X symbols, 1h + 15m)
[app] Charon Binance Futures started
```

**Check:**
- [ ] No errors during warmup
- [ ] WebSocket connects successfully
- [ ] Shows "1h + 15m" in logs (not just "15m")
- [ ] All watchlist symbols loaded

### 2. Kline Cache Check

**Look for logs like:**
```
[scanner] warming up klines for 10 symbols (1h + 15m)...
```

**Check:**
- [ ] Both timeframes mentioned (1h + 15m)
- [ ] No fetch errors
- [ ] Warmup completes in reasonable time

### 3. WebSocket Connection

**Look for:**
```
[scanner] WebSocket connected (10 symbols, 1h + 15m)
```

**Check:**
- [ ] Connection successful
- [ ] Both timeframes in stream
- [ ] No immediate disconnection

## 📊 Signal Detection Tests

### 4. Wait for First Scan

**Look for:**
```
[scanner] scan start | strategy=extreme_ob | allowed=extreme_ob | symbols=10
```

**Check:**
- [ ] Scan starts automatically
- [ ] Strategy loaded correctly
- [ ] Symbol count matches watchlist

### 5. Signal Processing

**Look for one of these:**

**A. Signal Detected:**
```
[ob] SIGNAL price=50000 trend=UPTREND: LONG R:R=2.5 entry=50000 sl=49250 tp=51500 (1H structure, 15m entry, IN OB ZONE)
```

**B. Signal Skipped (Expected):**
```
[ob] skip price=50000 trend=UPTREND: SL too close (0.3% < 0.5%)
[ob] skip price=50000 trend=UPTREND: TP too close (0.8% < 1.0%)
[ob] skip price=50000 trend=UPTREND: R:R 1.5 < 1.8
```

**C. Watch Alert:**
```
[ob] watch price=50000 trend=UPTREND: waiting for retrace to OB (0.12345-0.12567, dist=2.5%)
```

**Check:**
- [ ] Logs show "1H structure, 15m entry" (not just 15m)
- [ ] SL/TP distances shown in logs
- [ ] R:R ratio calculated correctly
- [ ] Skip reasons are clear

### 6. Distance Filter Working

**Look for:**
```
[ob] skip: SL too close (0.3% < 0.5%)
[ob] skip: TP too close (0.8% < 1.0%)
```

**Check:**
- [ ] Filter is active
- [ ] Percentage calculations correct
- [ ] Minimum thresholds enforced

## 🎯 Signal Quality Tests

### 7. Check Signal Meta

When a signal is detected, check Telegram message or logs for:

**Expected Meta:**
```javascript
{
  timeframe: '1H structure + 15m entry',
  slDistancePct: 1.5,  // should be >= 0.5
  tpDistancePct: 3.0,  // should be >= 1.0
  rrRatio: 2.5,        // should be >= 1.8
  trend: 'UPTREND',
  entry: 50000,
  stopLoss: 49250,     // should be significantly different from entry
  takeProfit: 51500,   // should be significantly different from entry
}
```

**Check:**
- [ ] `timeframe` field shows "1H structure + 15m entry"
- [ ] `slDistancePct` >= 0.5
- [ ] `tpDistancePct` >= 1.0
- [ ] `rrRatio` >= 1.8
- [ ] SL/TP are not too close to entry

### 8. Compare with Previous Signals

If you have historical data:

**Before Upgrade:**
- Entry: $50,000
- SL: $49,850 (0.3%)
- TP: $50,300 (0.6%)

**After Upgrade (Expected):**
- Entry: $50,000
- SL: $49,250 (1.5%)
- TP: $51,500 (3.0%)

**Check:**
- [ ] New SL/TP are larger
- [ ] Distance percentages increased
- [ ] R:R ratio maintained or improved

## 📈 Performance Tests

### 9. Signal Frequency

**Monitor for 1-2 hours:**

**Expected:**
- Fewer signals than before (30-50% reduction)
- More "skip" messages (filter working)
- Higher quality signals (larger SL/TP)

**Check:**
- [ ] Signal count decreased (more selective)
- [ ] Skip rate increased (filter active)
- [ ] Quality improved (larger distances)

### 10. WebSocket Stability

**Monitor for 1-2 hours:**

**Check:**
- [ ] No disconnections
- [ ] Kline updates received for both timeframes
- [ ] Cache updates correctly

### 11. Memory Usage

**Check:**
```bash
# On Mac/Linux
ps aux | grep node

# Or use Activity Monitor / htop
```

**Check:**
- [ ] Memory usage reasonable (< 500MB typically)
- [ ] No memory leaks over time
- [ ] CPU usage normal

## 🔧 Troubleshooting Tests

### 12. No Signals at All

**If no signals for > 2 hours:**

**Check:**
1. [ ] Market is trending (not ranging)
2. [ ] Watchlist has active symbols
3. [ ] Filters not too strict

**Try:**
```javascript
// In extremeOB.js, temporarily lower thresholds:
const MIN_SL_DISTANCE_PCT = 0.3;
const MIN_TP_DISTANCE_PCT = 0.6;
```

### 13. Too Many "Skip" Messages

**If 90%+ signals skipped:**

**Check:**
1. [ ] MIN_SL_DISTANCE_PCT not too high
2. [ ] MIN_TP_DISTANCE_PCT not too high
3. [ ] Swing window not too large

**Try:**
```javascript
// In extremeOB.js:
const MIN_SL_DISTANCE_PCT = 0.3;  // lower from 0.5
const MIN_TP_DISTANCE_PCT = 0.6;  // lower from 1.0
```

### 14. SL/TP Still Too Small

**If distances still < 1%:**

**Check:**
1. [ ] Using 1H for structure (not 15m)
2. [ ] Swing window is 5,5 (not 3,3)
3. [ ] OB lookback is 100 (not 40)

**Try:**
```javascript
// In extremeOB.js, increase thresholds:
const MIN_SL_DISTANCE_PCT = 1.0;
const MIN_TP_DISTANCE_PCT = 2.0;

// Or increase swing window:
const ms = detectMarketStructure(klines1h, 7, 7);
```

## 📊 Success Criteria

### ✅ Upgrade Successful If:

1. **Startup:**
   - [ ] Bot starts without errors
   - [ ] Both timeframes loaded (1h + 15m)
   - [ ] WebSocket connected

2. **Signal Quality:**
   - [ ] SL distance >= 0.5% (typically 1-2%)
   - [ ] TP distance >= 1.0% (typically 2-4%)
   - [ ] R:R ratio >= 1.8
   - [ ] Logs show "1H structure, 15m entry"

3. **Filtering:**
   - [ ] Distance filters active
   - [ ] Skip messages show reasons
   - [ ] Fewer but higher quality signals

4. **Stability:**
   - [ ] No crashes
   - [ ] WebSocket stable
   - [ ] Memory usage normal

## 📝 Test Results Log

### Test Date: ___________

**Startup:**
- [ ] Pass / [ ] Fail - Notes: ___________

**Signal Detection:**
- [ ] Pass / [ ] Fail - Notes: ___________

**Signal Quality:**
- [ ] Pass / [ ] Fail - Notes: ___________

**Performance:**
- [ ] Pass / [ ] Fail - Notes: ___________

**Overall:**
- [ ] Pass / [ ] Fail

**Issues Found:**
1. ___________
2. ___________
3. ___________

**Actions Taken:**
1. ___________
2. ___________
3. ___________

---

## 🆘 Need Help?

**Common Issues:**

1. **"No signals detected"**
   - Lower MIN_SL_DISTANCE_PCT and MIN_TP_DISTANCE_PCT
   - Check market is trending
   - Verify watchlist has active symbols

2. **"SL/TP still too small"**
   - Verify using 1H for structure
   - Increase swing window to 7,7 or 10,10
   - Increase MIN_SL_DISTANCE_PCT and MIN_TP_DISTANCE_PCT

3. **"WebSocket errors"**
   - Check internet connection
   - Verify Binance API accessible
   - Restart bot

4. **"Too many skip messages"**
   - This is normal! Filter is working
   - Lower thresholds if too strict
   - Monitor for a few hours to see pattern

---

**For detailed documentation, see:**
- `MULTI_TIMEFRAME_UPGRADE.md` - Full technical details
- `UPGRADE_SUMMARY.md` - Quick reference guide
