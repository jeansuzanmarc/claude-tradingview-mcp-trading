import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";

// ─── Config ────────────────────────────────────────────────────────────────

const rules = JSON.parse(readFileSync("rules.json", "utf8"));
const PARAMS = rules.parameters;

const CONFIG = {
  symbols: rules.watchlist,
  ltfInterval: rules.default_timeframe || "15m",
  htfInterval: rules.higher_timeframe || "4h",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "10"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const GOOGLE_SHEET_WEBHOOK = process.env.GOOGLE_SHEET_WEBHOOK || "";

const POSITIONS_FILE = "positions.json";
const LOG_FILE = "safety-check-log.json";
const CSV_FILE = "trades.csv";
const CSV_HEADERS = "Date,Time (UTC),Symbol,Side,Entry,Exit,SL,TP,Size USD,PnL USD,PnL %,Reason,Mode";

// ─── Persistence ───────────────────────────────────────────────────────────

function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) return {};
  return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
}

function savePositions(positions) {
  writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }
}

async function sendToGoogleSheets(payload) {
  if (!GOOGLE_SHEET_WEBHOOK) return;
  try {
    const res = await fetch(GOOGLE_SHEET_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
    });
    if (res.ok) console.log("  -> Google Sheets updated");
    else console.log(`  -> Google Sheets error: ${res.status}`);
  } catch (err) {
    console.log(`  -> Google Sheets error: ${err.message}`);
  }
}

function writeTradeCsv(entry) {
  const now = new Date();
  const data = {
    date: now.toISOString().slice(0, 10),
    time: now.toISOString().slice(11, 19),
    symbol: entry.symbol,
    side: entry.side,
    entryPrice: entry.entryPrice ? +entry.entryPrice.toFixed(4) : "",
    exitPrice: entry.exitPrice ? +entry.exitPrice.toFixed(4) : "",
    sl: entry.sl ? +entry.sl.toFixed(4) : "",
    tp: entry.tp ? +entry.tp.toFixed(4) : "",
    size: entry.size ? +entry.size.toFixed(2) : "",
    pnlUSD: entry.pnlUSD ? +entry.pnlUSD.toFixed(2) : "",
    pnlPct: entry.pnlPct ? +entry.pnlPct.toFixed(2) : "",
    reason: entry.reason || "",
    mode: CONFIG.paperTrading ? "PAPER" : "LIVE",
  };

  // CSV local backup
  const row = Object.values(data).join(",");
  appendFileSync(CSV_FILE, row + "\n");

  // Google Sheets
  sendToGoogleSheets(data);
}

// ─── Binance Data ──────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, limit) {
  const batchSize = 1000;
  let allCandles = [];
  let endTime = Date.now();
  while (allCandles.length < limit) {
    const toFetch = Math.min(batchSize, limit - allCandles.length);
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${toFetch}&endTime=${endTime}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status} for ${symbol}`);
    const data = await res.json();
    if (data.length === 0) break;
    const batch = data.map((k) => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
    allCandles = [...batch, ...allCandles];
    endTime = data[0][0] - 1;
    if (data.length < toFetch) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return allCandles;
}

// ─── Indicators ────────────────────────────────────────────────────────────

function calcEMASeries(closes, period) {
  const ema = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += closes[i];
    if (i === period - 1) ema[i] = sum / period;
  }
  const mult = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    ema[i] = closes[i] * mult + ema[i - 1] * (1 - mult);
  }
  return ema;
}

function calcATRSeries(candles, period) {
  const atr = new Array(candles.length).fill(null);
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    trs.push(tr);
    if (trs.length >= period) {
      if (atr[i - 1] === null) {
        atr[i] = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
      } else {
        atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
      }
    }
  }
  return atr;
}

function detectPivots(candles, leftBars, rightBars) {
  const pivotHighs = new Array(candles.length).fill(null);
  const pivotLows = new Array(candles.length).fill(null);
  for (let i = leftBars; i < candles.length - rightBars; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) pivotHighs[i + rightBars] = candles[i].high;
    if (isLow) pivotLows[i + rightBars] = candles[i].low;
  }
  return { pivotHighs, pivotLows };
}

function buildHTFLookup(htfCandles, emaPeriod) {
  const closes = htfCandles.map(c => c.close);
  const ema = calcEMASeries(closes, emaPeriod);
  return { candles: htfCandles, ema };
}

function getHTFValues(htfLookup, timestamp) {
  let idx = -1;
  for (let i = htfLookup.candles.length - 1; i >= 0; i--) {
    if (htfLookup.candles[i].time <= timestamp) { idx = i; break; }
  }
  if (idx < 0 || htfLookup.ema[idx] === null) return null;
  return { close: htfLookup.candles[idx].close, ema: htfLookup.ema[idx] };
}

// ─── Signal Detection ──────────────────────────────────────────────────────

function detectSignal(ltfCandles, htfLookup) {
  const closes = ltfCandles.map(c => c.close);
  const ltfEma = calcEMASeries(closes, PARAMS.ema_length);
  const ltfATR = calcATRSeries(ltfCandles, 14);
  const { pivotHighs, pivotLows } = detectPivots(ltfCandles, PARAMS.pivot_bars, PARAMS.pivot_bars);

  let lastHH = null, prevHH = null, lastHL = null, prevHL = null;
  let lastLL = null, prevLL = null, lastLH = null, prevLH = null;

  for (let i = 0; i < ltfCandles.length; i++) {
    if (pivotHighs[i] !== null) {
      prevHH = lastHH; lastHH = pivotHighs[i];
      prevLH = lastLH; lastLH = pivotHighs[i];
    }
    if (pivotLows[i] !== null) {
      prevHL = lastHL; lastHL = pivotLows[i];
      prevLL = lastLL; lastLL = pivotLows[i];
    }
  }

  const i = ltfCandles.length - 1;
  const c = ltfCandles[i];
  const prev = ltfCandles[i - 1];

  if (ltfEma[i] === null || ltfATR[i] === null) return null;

  const htf = getHTFValues(htfLookup, c.time);
  if (!htf) return null;

  const atr = ltfATR[i];

  // ── Check long ──
  const htfBull = htf.close > htf.ema;
  const ltfBull = c.close > ltfEma[i];
  const bullStructure = lastHH !== null && prevHH !== null &&
                        lastHL !== null && prevHL !== null &&
                        lastHH > prevHH && lastHL > prevHL;
  const bullCandle = c.close > c.open && c.close > prev.high;

  if (htfBull && ltfBull && bullStructure && bullCandle) {
    const sl = c.low;
    const risk = c.close - sl;
    if (risk > 0 && risk <= atr * PARAMS.sl_max_atr) {
      const tp = c.close + risk * PARAMS.risk_reward_ratio;
      return {
        side: "long", entryPrice: c.close, sl, tp, risk, atr,
        htfEma: htf.ema, ltfEma: ltfEma[i],
        structure: { lastHH, prevHH, lastHL, prevHL },
      };
    }
  }

  // ── Check short ──
  const htfBear = htf.close < htf.ema;
  const ltfBear = c.close < ltfEma[i];
  const bearStructure = lastLL !== null && prevLL !== null &&
                        lastLH !== null && prevLH !== null &&
                        lastLL < prevLL && lastLH < prevLH;
  const bearCandle = c.close < c.open && c.close < prev.low;

  if (htfBear && ltfBear && bearStructure && bearCandle) {
    const sl = c.high;
    const risk = sl - c.close;
    if (risk > 0 && risk <= atr * PARAMS.sl_max_atr) {
      const tp = c.close - risk * PARAMS.risk_reward_ratio;
      return {
        side: "short", entryPrice: c.close, sl, tp, risk, atr,
        htfEma: htf.ema, ltfEma: ltfEma[i],
        structure: { lastLL, prevLL, lastLH, prevLH },
      };
    }
  }

  return null;
}

// ─── Position Management ───────────────────────────────────────────────────

function checkPositionExit(position, candles) {
  for (const c of candles) {
    if (c.time <= position.entryTime) continue;

    if (position.side === "long") {
      if (c.low <= position.sl) {
        return { exitPrice: position.sl, exitTime: c.time, reason: "SL" };
      }
      if (c.high >= position.tp) {
        return { exitPrice: position.tp, exitTime: c.time, reason: "TP" };
      }
    } else {
      if (c.high >= position.sl) {
        return { exitPrice: position.sl, exitTime: c.time, reason: "SL" };
      }
      if (c.low <= position.tp) {
        return { exitPrice: position.tp, exitTime: c.time, reason: "TP" };
      }
    }
  }
  return null;
}

// ─── BitGet Execution ──────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto.createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message).digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path = CONFIG.tradeMode === "spot"
    ? "/api/v2/spot/trade/placeOrder"
    : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol, side, orderType: "market", quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES", marginMode: "isolated", marginCoin: "USDT",
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet: ${data.msg}`);
  return data.data;
}

// ─── Main Loop ─────────────────────────────────────────────────────────────

async function run() {
  initCsv();
  const log = loadLog();
  const positions = loadPositions();

  console.log("===================================================================");
  console.log("  MTF Trend Following Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "PAPER TRADING" : "LIVE TRADING"}`);
  console.log(`  Portfolio: $${CONFIG.portfolioValue} | Risk: ${PARAMS.position_size_pct}% | RR: 1:${PARAMS.risk_reward_ratio}`);
  console.log(`  Watchlist: ${CONFIG.symbols.join(", ")}`);
  console.log("===================================================================\n");

  // ── Time filters ──
  const now = new Date();
  const hourUTC = now.getUTCHours();
  const dowUTC = now.getUTCDay();
  const blackout = (PARAMS.blackout_hours_utc || []).includes(hourUTC);
  const noTradeDay = (PARAMS.no_trade_days || []).includes(dowUTC);

  if (blackout) console.log(`  [BLACKOUT] Hour ${hourUTC} UTC — no new entries\n`);
  if (noTradeDay) console.log(`  [NO TRADE DAY] Day ${dowUTC} — no new entries\n`);

  // Count today's trades
  const today = now.toISOString().slice(0, 10);
  const todayTrades = log.trades.filter(t => t.timestamp?.startsWith(today) && t.orderPlaced).length;
  console.log(`  Trades today: ${todayTrades}/${CONFIG.maxTradesPerDay}\n`);

  let newTrades = 0;

  for (const symbol of CONFIG.symbols) {
    console.log(`-- ${symbol} --`);

    try {
      const ltfCandles = await fetchCandles(symbol, CONFIG.ltfInterval, 500);
      const htfCandles = await fetchCandles(symbol, CONFIG.htfInterval, 200);
      const htfLookup = buildHTFLookup(htfCandles, PARAMS.ema_length);

      const currentPrice = ltfCandles[ltfCandles.length - 1].close;

      // ── Check open position ──
      if (positions[symbol]) {
        const pos = positions[symbol];
        const exit = checkPositionExit(pos, ltfCandles);

        if (exit) {
          const pnlPct = pos.side === "long"
            ? ((exit.exitPrice - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - exit.exitPrice) / pos.entryPrice) * 100;
          const pnlUSD = pos.size * (pnlPct / 100);

          console.log(`  CLOSE ${pos.side.toUpperCase()} @ $${exit.exitPrice.toFixed(2)} [${exit.reason}] PnL: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% ($${pnlUSD >= 0 ? "+" : ""}${pnlUSD.toFixed(2)})`);

          if (!CONFIG.paperTrading && exit.reason === "TP") {
            try {
              const closeSide = pos.side === "long" ? "sell" : "buy";
              await placeBitGetOrder(symbol, closeSide, pos.size, exit.exitPrice);
              console.log(`  Order placed to close position`);
            } catch (err) {
              console.log(`  ERROR closing: ${err.message}`);
            }
          }

          writeTradeCsv({
            symbol, side: pos.side, entryPrice: pos.entryPrice,
            exitPrice: exit.exitPrice, sl: pos.sl, tp: pos.tp,
            size: pos.size, pnlUSD, pnlPct, reason: exit.reason,
          });

          if (exit.reason === "SL") {
            positions[symbol] = { cooldownUntil: Date.now() + (PARAMS.cooldown_hours || 6) * 3600000 };
          } else {
            delete positions[symbol];
          }
          savePositions(positions);
          continue;
        }

        // Position still open
        const unrealPct = pos.side === "long"
          ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
        console.log(`  OPEN ${pos.side.toUpperCase()} @ $${pos.entryPrice.toFixed(2)} | Now: $${currentPrice.toFixed(2)} | Unreal: ${unrealPct >= 0 ? "+" : ""}${unrealPct.toFixed(2)}% | SL: $${pos.sl.toFixed(2)} | TP: $${pos.tp.toFixed(2)}`);
        continue;
      }

      // ── Check cooldown ──
      if (positions[symbol]?.cooldownUntil) {
        const remaining = positions[symbol].cooldownUntil - Date.now();
        if (remaining > 0) {
          console.log(`  COOLDOWN — ${(remaining / 3600000).toFixed(1)}h remaining`);
          continue;
        }
        delete positions[symbol];
        savePositions(positions);
      }

      // ── No new entries if blocked ──
      if (blackout || noTradeDay) { console.log("  Skipped (time filter)"); continue; }
      if (todayTrades + newTrades >= CONFIG.maxTradesPerDay) { console.log("  Skipped (daily limit)"); continue; }

      // ── Detect signal ──
      const signal = detectSignal(ltfCandles, htfLookup);

      if (!signal) {
        console.log(`  No signal | Price: $${currentPrice.toFixed(2)}`);
        continue;
      }

      // ── Entry ──
      const size = Math.min(
        CONFIG.portfolioValue * (PARAMS.position_size_pct / 100),
        CONFIG.maxTradeSizeUSD
      );

      console.log(`  SIGNAL ${signal.side.toUpperCase()}`);
      console.log(`    Entry: $${signal.entryPrice.toFixed(4)} | SL: $${signal.sl.toFixed(4)} | TP: $${signal.tp.toFixed(4)}`);
      console.log(`    Risk: $${(size * signal.risk / signal.entryPrice).toFixed(2)} | Size: $${size.toFixed(2)}`);
      console.log(`    HTF EMA(50): $${signal.htfEma.toFixed(2)} | LTF EMA(50): $${signal.ltfEma.toFixed(2)}`);

      if (CONFIG.paperTrading) {
        console.log(`    -> PAPER TRADE placed`);
      } else {
        try {
          const orderSide = signal.side === "long" ? "buy" : "sell";
          const order = await placeBitGetOrder(symbol, orderSide, size, signal.entryPrice);
          console.log(`    -> LIVE ORDER placed: ${order.orderId}`);
        } catch (err) {
          console.log(`    -> ORDER FAILED: ${err.message}`);
          continue;
        }
      }

      positions[symbol] = {
        side: signal.side,
        entryPrice: signal.entryPrice,
        entryTime: ltfCandles[ltfCandles.length - 1].time,
        sl: signal.sl,
        tp: signal.tp,
        size,
        risk: signal.risk,
      };
      savePositions(positions);

      writeTradeCsv({
        symbol, side: signal.side, entryPrice: signal.entryPrice,
        exitPrice: null, sl: signal.sl, tp: signal.tp,
        size, pnlUSD: null, pnlPct: null, reason: "ENTRY",
      });

      log.trades.push({
        timestamp: new Date().toISOString(),
        symbol, side: signal.side,
        entryPrice: signal.entryPrice,
        sl: signal.sl, tp: signal.tp, size,
        orderPlaced: true,
        paperTrading: CONFIG.paperTrading,
      });
      saveLog(log);
      newTrades++;

    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  // ── Summary ──
  const openCount = Object.values(positions).filter(p => p.side).length;
  const cooldownCount = Object.values(positions).filter(p => p.cooldownUntil && !p.side).length;
  console.log("\n===================================================================");
  console.log(`  Done. Open positions: ${openCount} | In cooldown: ${cooldownCount} | New trades: ${newTrades}`);
  console.log("===================================================================\n");
}

if (process.argv.includes("--tax-summary")) {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found.");
  } else {
    const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
    console.log(`\nTrade log: ${lines.length - 1} entries in ${CSV_FILE}\n`);
  }
} else {
  run().catch(err => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
