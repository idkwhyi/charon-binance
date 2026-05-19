# Charon Binance Futures

Bot trading otomatis untuk **Binance USDM Perpetual Futures** dengan dukungan **Long & Short**, leverage, dan LLM screening via Telegram.

> ⚠️ **Ini bukan financial advice.** Gunakan `dry_run` atau Testnet dulu sebelum live trading.

---

## Fitur

- 🟢🔴 **Long & Short** — LLM memilih arah berdasarkan signal teknikal
- ⚡ **Leverage** — Configurable per strategy (default 2x–10x)
- 🔒 **Isolated Margin** — Risiko terbatas per posisi
- 🤖 **LLM Screening** — OpenAI-compatible (GPT-4o-mini, Groq, Ollama, dll)
- 📊 **Signal Detection** — Volume spike, RSI, EMA crossover, Funding rate extreme
- 💬 **Telegram Control** — `/menu`, `/strategy`, `/positions`, `/pnl`, `/scan`
- 3 **Execution Mode** — `dry_run`, `confirm`, `live`
- 🛡️ **Native TP/SL** — `TAKE_PROFIT_MARKET` + `STOP_MARKET` ditempatkan otomatis

---

## Quick Start

```bash
git clone <this-repo>
cd charon-binance
npm install
cp .env.example .env
```

Edit `.env` dengan credentials kamu, lalu:

```bash
npm start
```

---

## Config Wajib

```env
TELEGRAM_BOT_TOKEN=   # Dari @BotFather
TELEGRAM_CHAT_ID=     # Chat/group ID tempat bot mengirim alert
```

Untuk `live` / `confirm` mode:

```env
BINANCE_API_KEY=
BINANCE_API_SECRET=
```

> API Key harus punya izin **Futures Trading**. Jangan aktifkan izin Withdraw.

---

## Execution Mode

```env
TRADING_MODE=dry_run   # dry_run | confirm | live
```

| Mode | Deskripsi |
|---|---|
| `dry_run` | Simulasi posisi di SQLite. Tidak ada order nyata. |
| `confirm` | Bot kirim alert + tombol Approve/Reject ke Telegram. Eksekusi hanya setelah kamu approve. |
| `live` | Langsung eksekusi order di Binance setelah LLM approve. |

---

## Testnet (Sangat Disarankan untuk Pertama Kali)

```env
BINANCE_FUTURES_BASE_URL=https://testnet.binancefuture.com
BINANCE_FUTURES_WS_URL=wss://stream.binancefuture.com
BINANCE_API_KEY=<testnet key dari https://testnet.binancefuture.com>
BINANCE_API_SECRET=<testnet secret>
TRADING_MODE=live
```

---

## Strategi

```
/strategy              — Lihat & ganti strategy aktif
/strategy scalp        — Switch ke scalp
/stratset scalp leverage 5
/stratset scalp tp_percent 2
/stratset scalp sl_percent -1.5
```

| Strategy | Signal | Leverage | TP | SL | LLM |
|---|---|---|---|---|---|
| `scalp` | volume_spike, ema_cross | 5x | 2% | -1.5% | ✅ |
| `swing` | rsi_oversold/overbought | 3x | 6% | -3% | ✅ |
| `funding_fade` | funding_extreme | 2x | 4% | -2% | ✅ |
| `degen` | volume_spike | 10x | 5% | -3% | ❌ |

---

## LLM Config

```env
LLM_BASE_URL=https://api.openai.com/v1   # Atau Groq, Ollama
LLM_API_KEY=
LLM_MODEL=gpt-4o-mini
ENABLE_LLM=true
```

LLM akan memilih: `BUY_LONG`, `BUY_SHORT`, `WATCH`, atau `PASS`.

Set `ENABLE_LLM=false` untuk disable LLM global (semua strategy jadi rule-based).

---

## Telegram Commands

```
/help          — List semua command
/menu          — Main menu
/strategy      — Lihat/ganti strategy
/stratset      — Edit setting strategy
/positions     — Lihat posisi terbuka
/pnl           — Ringkasan profit/loss
/watchlist     — Lihat watchlist
/scan          — Trigger scan manual
/lesson        — Tambah lesson untuk LLM
/lessons       — List semua lesson aktif
```

---

## Storage

Data disimpan di `charon-binance.sqlite`:

- Candidates & filter results
- LLM decisions & batch logs
- Positions (dry-run & live)
- Trade history
- Strategy config
- Learning lessons
- Trade intents

---

## Jalankan dengan PM2

```bash
npm install -g pm2
pm2 start index.js --name charon-binance
pm2 save
pm2 logs charon-binance
```

---

## Syntax Check

```bash
npm run check
```

---

## ⚠️ Risiko

- **Leverage + Futures = Risiko Likuidasi**. Jangan pakai uang yang tidak siap hilang.
- Bot selalu set `ISOLATED` margin secara default — satu posisi tidak menguras margin lain.
- Selalu test di `dry_run` atau Testnet sebelum live.
- Developer tidak bertanggung jawab atas hasil trading.
