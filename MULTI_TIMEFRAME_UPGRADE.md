# Multi-Timeframe Analysis Upgrade

## 🎯 Tujuan
Meningkatkan kualitas signal trading dengan menggunakan multi-timeframe analysis untuk mendapatkan entry, SL, dan TP yang lebih signifikan.

## ❌ Masalah Sebelumnya

### 1. **Single Timeframe (15m) untuk Semua Analisis**
- Market structure detection: 15m
- Order block detection: 15m
- Fibonacci retracement: 15m
- Entry timing: 15m

**Dampak:**
- Swing high/low terlalu kecil (hanya pergerakan 45 menit)
- SL/TP terlalu dekat dengan entry
- Banyak noise dan false signals
- R:R ratio meskipun >= 1.8, tetap dalam range kecil

### 2. **Swing Detection Terlalu Sensitif**
- Window: 3 candle kiri + 3 candle kanan
- Pada 15m = hanya 45 menit lookback
- Menangkap noise, bukan swing signifikan

### 3. **Order Block Lookback Pendek**
- Lookback: 40 candles × 15m = 10 jam
- Tidak menangkap institutional order blocks yang lebih besar

## ✅ Solusi yang Diimplementasikan

### 1. **Multi-Timeframe Analysis**

#### **1H Timeframe (Higher Timeframe) - Untuk Struktur**
- ✅ Market Structure Detection
- ✅ Order Block Detection
- ✅ Fibonacci Retracement
- ✅ Swing High/Low Identification

**Keuntungan:**
- Swing points lebih signifikan (5 jam lookback)
- Order blocks institutional-grade
- SL/TP lebih jauh dari entry (menghindari noise)
- Trend lebih jelas dan reliable

#### **15m Timeframe (Lower Timeframe) - Untuk Entry Timing**
- ✅ Current price monitoring
- ✅ Entry precision
- ✅ Real-time price action

**Keuntungan:**
- Entry timing yang presisi
- Menunggu harga retrace ke zona OB
- Konfirmasi entry yang akurat

### 2. **Swing Detection Window Diperbesar**
```javascript
// Sebelumnya: left=3, right=3 (45 menit pada 15m)
// Sekarang: left=5, right=5 (5 jam pada 1H)
```

**Dampak:**
- Swing points lebih signifikan
- Mengurangi false signals
- SL/TP lebih reliable

### 3. **Order Block Lookback Diperbesar**
```javascript
// Sebelumnya: lookback=40 (10 jam pada 15m)
// Sekarang: lookback=100 (100 jam pada 1H = ~4 hari)
```

**Dampak:**
- Menangkap institutional order blocks
- OB zones lebih kuat dan reliable
- Better entry zones

### 4. **Minimum Distance Filter**
```javascript
const MIN_SL_DISTANCE_PCT = 0.5;  // minimum 0.5% dari entry
const MIN_TP_DISTANCE_PCT = 1.0;  // minimum 1.0% dari entry
```

**Dampak:**
- Menghindari SL/TP yang terlalu dekat
- Filter out noise dan micro-movements
- Fokus pada setup yang signifikan

## 📊 Perubahan File

### 1. **scanner.js**
- ✅ Fetch 1H dan 15m klines
- ✅ Cache kedua timeframe
- ✅ WebSocket untuk 1H dan 15m streams
- ✅ Pass kedua timeframe ke indicators

### 2. **indicators.js**
- ✅ Terima klines1h dan klines15m
- ✅ Quick indicators tetap di 15m (volume spike, RSI, EMA)
- ✅ Extreme OB menggunakan kedua timeframe

### 3. **extremeOB.js**
- ✅ Terima klines1h dan klines15m
- ✅ Market structure dari 1H
- ✅ Order block dari 1H
- ✅ Fibonacci dari 1H swings
- ✅ Entry timing dari 15m
- ✅ Tambah minimum distance filter
- ✅ Swing window 5,5 (dari 3,3)

### 4. **marketStructure.js**
- ✅ Default window: left=5, right=5 (dari 3,3)
- ✅ Lebih cocok untuk 1H timeframe

### 5. **orderBlock.js**
- ✅ Default lookback: 100 (dari 40)
- ✅ Menangkap institutional zones

### 6. **candidateBuilder.js**
- ✅ Simpan snapshot kedua timeframe
- ✅ last5_1h dan last5_15m

## 🎯 Hasil yang Diharapkan

### **Sebelum:**
```
Entry: $50,000
SL: $49,850 (0.3% = $150)
TP: $50,300 (0.6% = $300)
R:R: 1:2
```
❌ Terlalu kecil, mudah kena noise

### **Sesudah:**
```
Entry: $50,000
SL: $49,250 (1.5% = $750)
TP: $51,500 (3.0% = $1,500)
R:R: 1:2
```
✅ Lebih signifikan, menghindari noise

## 🚀 Cara Menggunakan

### **1. Restart Bot**
```bash
npm start
```

### **2. Monitor Logs**
Perhatikan log baru:
```
[scanner] warming up klines for X symbols (1h + 15m)...
[scanner] WebSocket connected (X symbols, 1h + 15m)
[ob] SIGNAL: LONG R:R=2.5 entry=50000 sl=49250 tp=51500 (1H structure, 15m entry, IN OB ZONE)
```

### **3. Perhatikan Meta Signal**
Signal sekarang include:
```javascript
{
  timeframe: '1H structure + 15m entry',
  slDistancePct: 1.5,  // jarak SL dalam %
  tpDistancePct: 3.0,  // jarak TP dalam %
  // ... meta lainnya
}
```

## ⚙️ Tuning Parameters (Opsional)

### **Jika SL/TP Masih Terlalu Kecil:**
Edit `extremeOB.js`:
```javascript
const MIN_SL_DISTANCE_PCT = 1.0;  // naikkan dari 0.5
const MIN_TP_DISTANCE_PCT = 2.0;  // naikkan dari 1.0
```

### **Jika Swing Terlalu Sensitif:**
Edit `extremeOB.js`:
```javascript
const ms = detectMarketStructure(klines1h, 7, 7); // naikkan dari 5,5
```

### **Jika Ingin OB Lebih Selektif:**
Edit `orderBlock.js`:
```javascript
export function detectOrderBlocks(klines, impulseMinPct = 1.0, lookback = 100) {
  // naikkan impulseMinPct dari 0.5 ke 1.0
}
```

## 📈 Monitoring

### **Metrics to Watch:**
1. **Signal Frequency**: Harusnya berkurang (lebih selektif)
2. **R:R Ratio**: Harusnya tetap >= 1.8
3. **SL Distance**: Harusnya >= 0.5%
4. **TP Distance**: Harusnya >= 1.0%
5. **Win Rate**: Harusnya meningkat (less noise)

### **Expected Behavior:**
- ✅ Fewer signals (lebih selektif)
- ✅ Larger SL/TP distances
- ✅ Better R:R ratios
- ✅ Less false signals
- ✅ More reliable entries

## 🔧 Troubleshooting

### **Problem: Tidak ada signal sama sekali**
**Solution:**
1. Turunkan MIN_SL_DISTANCE_PCT dan MIN_TP_DISTANCE_PCT
2. Turunkan swing window ke 4,4 atau 3,3
3. Check logs untuk melihat alasan skip

### **Problem: SL/TP masih terlalu kecil**
**Solution:**
1. Naikkan MIN_SL_DISTANCE_PCT dan MIN_TP_DISTANCE_PCT
2. Naikkan swing window ke 7,7 atau 10,10
3. Pertimbangkan gunakan 4H timeframe untuk struktur

### **Problem: Terlalu banyak "skip: SL too close" atau "skip: TP too close"**
**Solution:**
- Ini normal! Filter bekerja dengan baik
- Turunkan threshold jika terlalu ketat
- Monitor beberapa hari untuk lihat pattern

## 📝 Notes

1. **Backward Compatibility**: Indicator lain (RSI, EMA, volume spike) tetap menggunakan 15m untuk quick signals
2. **WebSocket**: Sekarang subscribe ke 2× streams (1h + 15m), pastikan connection stable
3. **Memory**: Cache sekarang menyimpan 2 timeframe, tapi masih ringan (100 candles × 2)
4. **Performance**: Minimal impact, hanya tambah 1 fetch per symbol saat warmup

## 🎓 Trading Logic

### **Entry Style (Tetap Sama):**
- ✅ Menunggu harga retrace ke OB zone
- ✅ Tidak direct entry
- ✅ Konfirmasi dengan Fibonacci 79%
- ✅ Entry saat price IN OB zone

### **What Changed:**
- ✅ OB zone sekarang dari 1H (lebih besar, lebih kuat)
- ✅ Swing points dari 1H (lebih signifikan)
- ✅ SL/TP lebih jauh (menghindari noise)
- ✅ Filter minimum distance (quality over quantity)

---

**Version**: 2.0.0  
**Date**: 2026-05-20  
**Author**: Kiro AI Assistant
