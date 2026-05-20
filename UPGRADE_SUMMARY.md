# 🚀 Multi-Timeframe Upgrade - Quick Summary

## ✅ Apa yang Berubah?

### **Sebelum:**
- Semua analisis di 15m timeframe
- Swing window: 3 candle (45 menit)
- OB lookback: 40 candles (10 jam)
- SL/TP terlalu dekat dengan entry

### **Sesudah:**
- **1H timeframe** untuk struktur (market structure, OB, fibonacci)
- **15m timeframe** untuk entry timing
- Swing window: 5 candle (5 jam pada 1H)
- OB lookback: 100 candles (100 jam pada 1H)
- Minimum distance filter: SL >= 0.5%, TP >= 1.0%

## 📊 Perbandingan

| Aspek | Sebelum | Sesudah |
|-------|---------|---------|
| **Timeframe Struktur** | 15m | 1H |
| **Timeframe Entry** | 15m | 15m |
| **Swing Window** | 3,3 (45 min) | 5,5 (5 jam) |
| **OB Lookback** | 40 (10 jam) | 100 (100 jam) |
| **Min SL Distance** | - | 0.5% |
| **Min TP Distance** | - | 1.0% |
| **Typical SL** | 0.3-0.5% | 1.0-2.0% |
| **Typical TP** | 0.6-1.0% | 2.0-4.0% |

## 🎯 Keuntungan

1. ✅ **SL/TP Lebih Besar**: Menghindari noise dan micro-movements
2. ✅ **Swing Lebih Signifikan**: Dari 1H timeframe, bukan 15m
3. ✅ **OB Institutional-Grade**: Lookback 100 jam menangkap zona besar
4. ✅ **Less False Signals**: Filter minimum distance
5. ✅ **Better R:R**: Tetap >= 1.8 tapi dengan range lebih besar
6. ✅ **Entry Presisi**: 15m untuk timing yang akurat

## 🚀 Cara Restart

```bash
# Stop bot jika sedang running
# Ctrl+C atau kill process

# Start ulang
npm start
```

## 📝 Log yang Diharapkan

```
[scanner] warming up klines for 10 symbols (1h + 15m)...
[scanner] warmup done
[scanner] WebSocket connected (10 symbols, 1h + 15m)
[ob] SIGNAL price=50000 trend=UPTREND: LONG R:R=2.5 entry=50000 sl=49250 tp=51500 (1H structure, 15m entry, IN OB ZONE)
```

## ⚙️ Quick Tuning

### Jika SL/TP Masih Terlalu Kecil:
Edit `src/signals/extremeOB.js` line 20-21:
```javascript
const MIN_SL_DISTANCE_PCT = 1.0;  // naikkan dari 0.5
const MIN_TP_DISTANCE_PCT = 2.0;  // naikkan dari 1.0
```

### Jika Terlalu Sedikit Signal:
Edit `src/signals/extremeOB.js` line 20-21:
```javascript
const MIN_SL_DISTANCE_PCT = 0.3;  // turunkan dari 0.5
const MIN_TP_DISTANCE_PCT = 0.6;  // turunkan dari 1.0
```

### Jika Swing Terlalu Sensitif:
Edit `src/signals/extremeOB.js` line 44:
```javascript
const ms = detectMarketStructure(klines1h, 7, 7); // naikkan dari 5,5
```

## 🔍 Monitoring

### Check Signal Quality:
```bash
# Monitor logs untuk melihat:
# 1. Berapa banyak signal detected
# 2. Berapa yang di-skip karena "SL too close" atau "TP too close"
# 3. R:R ratio dari signal yang pass
# 4. Distance SL dan TP dalam %
```

### Expected Metrics:
- **Signal Frequency**: Berkurang 30-50% (lebih selektif)
- **Average SL Distance**: 1.0-2.0% (dari 0.3-0.5%)
- **Average TP Distance**: 2.0-4.0% (dari 0.6-1.0%)
- **R:R Ratio**: Tetap >= 1.8
- **Win Rate**: Meningkat (less noise)

## 📁 Files Modified

1. ✅ `src/signals/scanner.js` - Multi-timeframe fetch & WebSocket
2. ✅ `src/signals/indicators.js` - Accept 2 timeframes
3. ✅ `src/signals/extremeOB.js` - Multi-timeframe logic + distance filter
4. ✅ `src/signals/marketStructure.js` - Larger swing window (5,5)
5. ✅ `src/signals/orderBlock.js` - Larger lookback (100)
6. ✅ `src/pipeline/candidateBuilder.js` - Store both timeframes

## ❓ FAQ

**Q: Apakah strategi entry berubah?**  
A: Tidak. Tetap menunggu harga retrace ke OB zone, bukan direct entry.

**Q: Apakah leverage berubah?**  
A: Tidak. Leverage tetap sama, hanya SL/TP yang lebih besar.

**Q: Apakah margin usage berubah?**  
A: Tidak. Margin tetap $2 per position, leverage digunakan untuk adjust size.

**Q: Apakah indicator lain (RSI, EMA) berubah?**  
A: Tidak. Mereka tetap di 15m untuk quick signals. Hanya Extreme OB yang multi-timeframe.

**Q: Apakah perlu update .env?**  
A: Tidak. Semua config tetap sama.

**Q: Berapa lama warmup?**  
A: Sama seperti sebelumnya, hanya fetch 2× timeframe (1h + 15m).

---

**Untuk detail lengkap, baca**: `MULTI_TIMEFRAME_UPGRADE.md`
