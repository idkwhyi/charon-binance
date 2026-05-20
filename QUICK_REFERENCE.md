# 🚀 Quick Reference Card - Multi-Timeframe Trading Bot

## 📋 Key Changes Summary

| Aspect | Before | After |
|--------|--------|-------|
| Structure Timeframe | 15m | **1H** |
| Entry Timeframe | 15m | **15m** |
| Swing Window | 3,3 | **5,5** |
| OB Lookback | 40 | **100** |
| Min SL Distance | None | **0.5%** |
| Min TP Distance | None | **1.0%** |

## 🎯 Expected Signal Quality

| Metric | Target Range |
|--------|--------------|
| Signal Frequency | 5-15 per day |
| SL Distance | 1.0-2.5% |
| TP Distance | 2.0-5.0% |
| R:R Ratio | 1.8-3.0 |
| Skip Rate | 30-60% |

## ⚙️ Quick Tuning

### Too Few Signals?
```javascript
// extremeOB.js line 20-21
MIN_SL_DISTANCE_PCT = 0.3  // ↓ from 0.5
MIN_TP_DISTANCE_PCT = 0.6  // ↓ from 1.0
```

### SL/TP Too Small?
```javascript
// extremeOB.js line 20-21
MIN_SL_DISTANCE_PCT = 1.0  // ↑ from 0.5
MIN_TP_DISTANCE_PCT = 2.0  // ↑ from 1.0
```

### Too Many Signals?
```javascript
// extremeOB.js line 44
detectMarketStructure(klines1h, 7, 7)  // ↑ from 5,5
```

## 📁 Files Modified

1. `src/signals/scanner.js` - Multi-timeframe
2. `src/signals/indicators.js` - Accept 2 TF
3. `src/signals/extremeOB.js` - Main logic
4. `src/signals/marketStructure.js` - Swing 5,5
5. `src/signals/orderBlock.js` - Lookback 100
6. `src/pipeline/candidateBuilder.js` - Store 2 TF

## 🔍 Log Patterns

### ✅ Good Signal
```
[ob] SIGNAL price=50000 trend=UPTREND: LONG R:R=2.5 
entry=50000 sl=49250 tp=51500 
(1H structure, 15m entry, IN OB ZONE)
```

### ⚠️ Filtered (Normal)
```
[ob] skip: SL too close (0.3% < 0.5%)
[ob] skip: TP too close (0.8% < 1.0%)
[ob] skip: R:R 1.5 < 1.8
```

### 👀 Watch Alert
```
[ob] watch: waiting for retrace to OB 
(0.12345-0.12567, dist=2.5%)
```

## 🚀 Commands

```bash
# Start bot
npm start

# Check logs
tail -f logs/app.log  # if logging to file

# Backup database
cp charon-binance.sqlite charon-binance.sqlite.backup

# Restore database
cp charon-binance.sqlite.backup charon-binance.sqlite
```

## 📊 Monitoring Checklist

- [ ] Bot starts without errors
- [ ] Logs show "1h + 15m"
- [ ] WebSocket connected
- [ ] Signals show "1H structure, 15m entry"
- [ ] SL distance >= 0.5%
- [ ] TP distance >= 1.0%
- [ ] R:R >= 1.8
- [ ] Skip messages show reasons

## 🆘 Quick Troubleshooting

| Problem | Quick Fix |
|---------|-----------|
| No signals | Lower MIN_SL/TP_DISTANCE_PCT |
| SL/TP too small | Increase MIN_SL/TP_DISTANCE_PCT |
| Too many signals | Increase swing window to 7,7 |
| Bot crashes | Check syntax, revert changes |
| WebSocket errors | Check internet, restart bot |

## 📚 Documentation Files

- `UPGRADE_SUMMARY.md` - Quick overview
- `MULTI_TIMEFRAME_UPGRADE.md` - Full details
- `TESTING_CHECKLIST.md` - Testing guide
- `TUNING_GUIDE.md` - Parameter tuning
- `QUICK_REFERENCE.md` - This file

## 🎓 Strategy Reminder

**Entry Style:** Wait for price to retrace to OB zone (not direct entry)

**Timeframe Logic:**
- 1H: Identify trend, OB zones, swing points
- 15m: Precise entry timing when price enters OB

**Filters:**
1. Market structure (UPTREND/DOWNTREND)
2. Valid OB zone (not violated)
3. Fibonacci 79% retracement
4. Price IN OB zone
5. SL distance >= 0.5%
6. TP distance >= 1.0%
7. R:R >= 1.8

## 💡 Pro Tips

1. **Be Patient**: Fewer signals = higher quality
2. **Monitor Skip Rate**: 30-60% is healthy
3. **Check Distance**: SL/TP should be 1-3% typically
4. **Tune Gradually**: Small changes, test 24h
5. **Trust the Filter**: "Skip" messages are good!

## 📞 Support

**Check logs first:**
- Startup errors?
- Signal detection working?
- Skip reasons clear?

**Common issues:**
- Too few signals → Lower thresholds
- SL/TP small → Increase thresholds
- Too many signals → Increase swing window

**Need more help?**
- Read `MULTI_TIMEFRAME_UPGRADE.md`
- Check `TUNING_GUIDE.md`
- Review `TESTING_CHECKLIST.md`

---

**Version:** 2.0.0  
**Date:** 2026-05-20  
**Strategy:** Extreme Order Block (Multi-Timeframe)
