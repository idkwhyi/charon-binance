# ⚙️ Tuning Guide - Multi-Timeframe Parameters

## 🎯 Overview

Setelah upgrade multi-timeframe, Anda bisa fine-tune beberapa parameter untuk menyesuaikan dengan style trading Anda.

## 📊 Parameter Matrix

| Parameter | File | Default | Conservative | Aggressive | Impact |
|-----------|------|---------|--------------|------------|--------|
| **MIN_SL_DISTANCE_PCT** | extremeOB.js | 0.5% | 1.0% | 0.3% | Filter SL terlalu dekat |
| **MIN_TP_DISTANCE_PCT** | extremeOB.js | 1.0% | 2.0% | 0.6% | Filter TP terlalu dekat |
| **Swing Window** | extremeOB.js | 5,5 | 7,7 | 3,3 | Ukuran swing points |
| **OB Lookback** | orderBlock.js | 100 | 150 | 50 | Jangkauan OB detection |
| **MIN_RR** | extremeOB.js | 1.8 | 2.0 | 1.5 | Minimum Risk:Reward |

## 🎚️ Tuning Scenarios

### Scenario 1: "Terlalu Sedikit Signal"

**Problem:**
- Tidak ada signal selama berjam-jam
- Terlalu banyak "skip: SL too close" atau "skip: TP too close"

**Solution - Aggressive Settings:**

Edit `src/signals/extremeOB.js`:
```javascript
// Line 20-21
const MIN_SL_DISTANCE_PCT = 0.3;  // turunkan dari 0.5
const MIN_TP_DISTANCE_PCT = 0.6;  // turunkan dari 1.0
const MIN_RR = 1.5;               // turunkan dari 1.8

// Line 44
const ms = detectMarketStructure(klines1h, 3, 3); // turunkan dari 5,5
```

Edit `src/signals/orderBlock.js`:
```javascript
// Line 28
export function detectOrderBlocks(klines, impulseMinPct = 0.5, lookback = 50) {
  // turunkan lookback dari 100 ke 50
}
```

**Expected Result:**
- ✅ Lebih banyak signal
- ⚠️ Lebih banyak noise
- ⚠️ SL/TP lebih kecil

---

### Scenario 2: "SL/TP Masih Terlalu Kecil"

**Problem:**
- Signal detected tapi SL/TP masih < 1%
- Ingin setup yang lebih besar dan signifikan

**Solution - Conservative Settings:**

Edit `src/signals/extremeOB.js`:
```javascript
// Line 20-21
const MIN_SL_DISTANCE_PCT = 1.0;  // naikkan dari 0.5
const MIN_TP_DISTANCE_PCT = 2.0;  // naikkan dari 1.0
const MIN_RR = 2.0;               // naikkan dari 1.8

// Line 44
const ms = detectMarketStructure(klines1h, 7, 7); // naikkan dari 5,5
```

Edit `src/signals/orderBlock.js`:
```javascript
// Line 28
export function detectOrderBlocks(klines, impulseMinPct = 0.8, lookback = 150) {
  // naikkan lookback dari 100 ke 150
  // naikkan impulseMinPct dari 0.5 ke 0.8
}
```

**Expected Result:**
- ✅ SL/TP lebih besar (2-5%)
- ✅ Setup lebih signifikan
- ⚠️ Lebih sedikit signal

---

### Scenario 3: "Balanced - Default Optimal"

**Current Default Settings:**

`src/signals/extremeOB.js`:
```javascript
const MIN_SL_DISTANCE_PCT = 0.5;  // minimum 0.5%
const MIN_TP_DISTANCE_PCT = 1.0;  // minimum 1.0%
const MIN_RR = 1.8;               // minimum R:R 1:1.8

// Line 44
const ms = detectMarketStructure(klines1h, 5, 5); // 5 jam window
```

`src/signals/orderBlock.js`:
```javascript
export function detectOrderBlocks(klines, impulseMinPct = 0.5, lookback = 100) {
  // 100 candles = 100 jam pada 1H
}
```

**Expected Result:**
- ✅ Balance antara frequency dan quality
- ✅ SL/TP 1-3% typically
- ✅ Moderate signal count

---

### Scenario 4: "Scalping Style (Not Recommended)"

**Problem:**
- Ingin entry/exit cepat
- Tidak masalah dengan SL/TP kecil

**Solution - Scalping Settings:**

Edit `src/signals/extremeOB.js`:
```javascript
// Line 20-21
const MIN_SL_DISTANCE_PCT = 0.2;  // sangat kecil
const MIN_TP_DISTANCE_PCT = 0.4;  // sangat kecil
const MIN_RR = 1.5;               // lebih rendah

// Line 44
const ms = detectMarketStructure(klines1h, 3, 3); // window kecil
```

**⚠️ Warning:**
- Tidak sesuai dengan strategi Extreme OB
- Banyak false signals
- High noise, low win rate
- **Not recommended!**

---

### Scenario 5: "Swing Trading Style"

**Problem:**
- Ingin hold position lebih lama
- Ingin SL/TP yang sangat besar

**Solution - Swing Settings:**

**Option A: Gunakan 4H Timeframe**

Edit `src/signals/scanner.js`:
```javascript
// Line 18 - warmupKlines
const k4h = await fetchKlines(symbol, '4h', 100);
const k15m = await fetchKlines(symbol, '15m', 100);
klineCache.set(symbol, { '4h': k4h, '15m': k15m });

// Line 48 - scanSignals
let klines4h = cache['4h'];
// ... fetch if missing

// Line 70 - runIndicators
const allSignals = runIndicators(klines4h, klines15m, fundingRate, strat);

// Line 118 - startWebSocket
streams.push(`${sym.toLowerCase()}@kline_4h`);
```

Edit `src/signals/indicators.js`:
```javascript
// Line 73
export function runIndicators(klines4h, klines15m, fundingRate, stratConfig) {
  // ...
  if (klines4h && klines4h.length >= 20 && klines15m && klines15m.length >= 20) {
    const obSignals = detectExtremeOB(klines4h, klines15m, fundingRate);
    signals.push(...obSignals);
  }
}
```

Edit `src/signals/extremeOB.js`:
```javascript
// Line 20-21
const MIN_SL_DISTANCE_PCT = 1.5;  // lebih besar
const MIN_TP_DISTANCE_PCT = 3.0;  // lebih besar
const MIN_RR = 2.0;               // lebih tinggi

// Line 44
const ms = detectMarketStructure(klines4h, 5, 5); // 4H × 5 = 20 jam window
```

**Expected Result:**
- ✅ SL/TP sangat besar (3-10%)
- ✅ Setup sangat signifikan
- ⚠️ Sangat sedikit signal (1-2 per hari)
- ✅ Cocok untuk swing trading

---

## 🔧 Step-by-Step Tuning Process

### Step 1: Baseline (Run Default for 24 Hours)

1. Start bot dengan default settings
2. Monitor logs untuk 24 jam
3. Catat:
   - Berapa signal detected?
   - Berapa signal skipped?
   - Average SL/TP distance?
   - R:R ratio?

### Step 2: Identify Issue

**Too Few Signals (<5 per day):**
- Go to Scenario 1 (Aggressive)

**SL/TP Too Small (<1%):**
- Go to Scenario 2 (Conservative)

**Too Many Signals (>20 per day):**
- Go to Scenario 2 (Conservative)

**Balanced (5-15 per day, SL/TP 1-3%):**
- Keep default (Scenario 3)

### Step 3: Apply Changes

1. Edit files according to scenario
2. Restart bot
3. Monitor for 24 hours

### Step 4: Iterate

Repeat Step 1-3 until satisfied with:
- Signal frequency
- SL/TP distances
- Win rate
- R:R ratio

## 📊 Monitoring Metrics

### Key Metrics to Track:

1. **Signal Frequency**
   - Target: 5-15 signals per day
   - Too low: < 3 per day
   - Too high: > 25 per day

2. **SL Distance**
   - Target: 1.0-2.5%
   - Too low: < 0.5%
   - Too high: > 5%

3. **TP Distance**
   - Target: 2.0-5.0%
   - Too low: < 1.0%
   - Too high: > 10%

4. **R:R Ratio**
   - Target: 1.8-3.0
   - Too low: < 1.5
   - Too high: > 5.0 (unrealistic)

5. **Skip Rate**
   - Target: 30-60% skipped
   - Too low: < 20% (filter not working)
   - Too high: > 80% (filter too strict)

## 🎯 Recommended Presets

### Preset 1: "Balanced" (Default)
```javascript
// extremeOB.js
MIN_SL_DISTANCE_PCT = 0.5
MIN_TP_DISTANCE_PCT = 1.0
MIN_RR = 1.8
Swing Window = 5,5

// orderBlock.js
lookback = 100
impulseMinPct = 0.5
```
**Best for:** Most traders, balanced approach

---

### Preset 2: "Quality Over Quantity"
```javascript
// extremeOB.js
MIN_SL_DISTANCE_PCT = 1.0
MIN_TP_DISTANCE_PCT = 2.0
MIN_RR = 2.0
Swing Window = 7,7

// orderBlock.js
lookback = 150
impulseMinPct = 0.8
```
**Best for:** Patient traders, larger positions

---

### Preset 3: "Active Trading"
```javascript
// extremeOB.js
MIN_SL_DISTANCE_PCT = 0.3
MIN_TP_DISTANCE_PCT = 0.6
MIN_RR = 1.5
Swing Window = 3,3

// orderBlock.js
lookback = 50
impulseMinPct = 0.5
```
**Best for:** Active traders, more opportunities

---

## 🔍 Advanced Tuning

### Fine-Tune Fibonacci Tolerance

Edit `src/signals/fibonacci.js`:
```javascript
// Line 54
export function isPriceInFibZone(currentPrice, swingLow, swingHigh, direction, tolerance = 0.02) {
  // Default tolerance = 0.02 (2%)
  // Increase to 0.03 for wider zone
  // Decrease to 0.01 for stricter zone
}
```

### Fine-Tune OB Tolerance

Edit `src/signals/orderBlock.js`:
```javascript
// Line 82
export function isPriceInOrderBlock(currentPrice, ob, tolerance = 0.5) {
  // Default tolerance = 0.5 (50% of OB range)
  // Increase to 1.0 for wider zone
  // Decrease to 0.3 for stricter zone
}
```

### Fine-Tune Funding Rate Filter

Edit `src/signals/extremeOB.js`:
```javascript
// Line 48-56
if (direction === 'LONG'  && fr >  0.002) {  // default 0.002
  // Increase to 0.003 for more lenient
  // Decrease to 0.001 for stricter
}
if (direction === 'SHORT' && fr < -0.001) {  // default -0.001
  // Decrease to -0.002 for more lenient
  // Increase to -0.0005 for stricter
}
```

---

## 📝 Tuning Log Template

```
Date: ___________
Preset: ___________

Settings:
- MIN_SL_DISTANCE_PCT: _____
- MIN_TP_DISTANCE_PCT: _____
- MIN_RR: _____
- Swing Window: _____
- OB Lookback: _____

Results (24h):
- Signals Detected: _____
- Signals Skipped: _____
- Skip Rate: _____%
- Avg SL Distance: _____%
- Avg TP Distance: _____%
- Avg R:R: _____

Observations:
- ___________
- ___________

Next Action:
- ___________
```

---

## 🆘 Troubleshooting

**Problem: Changes not taking effect**
- Solution: Restart bot after editing files

**Problem: Bot crashes after changes**
- Solution: Check syntax errors, revert changes

**Problem: Unexpected behavior**
- Solution: Check logs, verify parameter values

---

**Remember:** Tuning adalah proses iteratif. Butuh waktu untuk menemukan setting optimal untuk style trading Anda!
