// ============================================================================
// TradeForge — Signal Engine + Paper Trading Dashboard (v1)
// Stack: Railway + Express + (optional) Claude API
//
// PIPELINE:  Signal (webhook | internal engine) → Risk Gate → Paper Execution
//            → [STUBBED] Live Execution
//
// IMPORTANT: Live order placement is NOT wired in this build. All broker
// endpoints return 501 with wiring instructions. Paper mode is always on.
//
// Core signal/risk/paper logic runs WITHOUT any AI call. The Claude proxy at
// /api/claude is optional (used only for "reason over today's setups").
// ============================================================================

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;

// Shared secret for TradingView webhooks. Set WEBHOOK_SECRET in Railway.
// TradingView alert messages must include {"secret":"<value>", ...}.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me";

// ============================================================================
// PERSISTENCE
// State is written to ./data/state.json after every mutation.
// NOTE: Railway's default filesystem is EPHEMERAL — it resets on redeploy.
// To persist trade history across deploys, attach a Railway Volume mounted
// at /app/data (Project → service → Volumes → mount path /app/data).
// ============================================================================
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

function defaultModeRisk(overrides = {}) {
  return Object.assign(
    {
      enabled: true,
      startingEquity: 10000,     // USD, paper
      riskPerTradePct: 1.0,      // % of current equity risked per trade
      maxTradesPerDay: 3,
      maxDailyLossPct: 3.0,      // stop trading for the day at this drawdown
      sessionWindow: null,       // e.g. { start: "07:00", end: "20:00" } or null = any time
      tzOffsetMinutes: 120,      // SAST = UTC+2. All window checks use this offset.
    },
    overrides
  );
}

function defaultState() {
  return {
    createdAt: new Date().toISOString(),
    exchangeRate: 18.5, // USD → ZAR, user-editable in dashboard
    modes: {
      scalp: {
        label: "Scalp",
        timeframes: "1m / 5m / 15m",
        risk: defaultModeRisk({ riskPerTradePct: 0.5, maxTradesPerDay: 8, maxDailyLossPct: 2.0 }),
      },
      day: {
        label: "Day",
        timeframes: "15m / 30m / 1H",
        risk: defaultModeRisk({ riskPerTradePct: 1.0, maxTradesPerDay: 3, maxDailyLossPct: 3.0 }),
      },
      swing: {
        label: "Swing / Position",
        timeframes: "Daily",
        risk: defaultModeRisk({ riskPerTradePct: 1.5, maxTradesPerDay: 1, maxDailyLossPct: 5.0 }),
      },
      gold_session: {
        label: "Gold Session (1/day)",
        timeframes: "15m execution, session window",
        risk: defaultModeRisk({
          riskPerTradePct: 1.0,
          maxTradesPerDay: 1, // hard rule of this strategy
          maxDailyLossPct: 2.0,
          sessionWindow: { start: "16:00", end: "17:00" }, // SAST, London/NY overlap
        }),
      },
    },
    // BOS + Retest engine config — every value here is a tunable judgment call.
    engine: {
      lookback: 40,             // bars scanned to find the consolidation block
      minTouches: 2,            // touches required on EACH edge for a valid range
      touchTolerancePct: 15,    // % of range height counting as "touching" an edge
      maxRangeHeightPct: 1.2,   // range height as % of price — larger = not a block
      breakBufferPct: 5,        // close must clear the edge by this % of range height
      retestTolerancePct: 20,   // proximity to broken edge (% of range height) = retest
      maxBarsToRetest: 20,      // break expires if no retest within N bars
      confirmation: "close_direction", // close_direction | engulfing | rejection_wick
      stopPlacement: "retest_candle",  // retest_candle | block_far_edge
      stopBufferPct: 10,        // extra room beyond stop anchor, % of range height
      targetRR: 2.0,            // default take-profit at N × risk
    },
    // Per-symbol engine state machines (SCANNING → BROKEN → SIGNAL)
    engineStates: {},           // key: `${mode}:${symbol}`
    candles: {},                // key: `${mode}:${symbol}` → last N candles
    openTrades: [],
    closedTrades: [],
    signalLog: [],              // every signal + gate decision, incl. rejections
    goldReasoningLog: [],       // exact reasoning behind each gold-session signal
    lastPrices: {},             // symbol → last known price
  };
}

let state = loadState();

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      // Merge over defaults so new config keys appear after upgrades
      return Object.assign(defaultState(), loaded);
    }
  } catch (e) {
    console.error("State load failed, starting fresh:", e.message);
  }
  return defaultState();
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error("State save failed:", e.message);
    }
  }, 150);
}

// ============================================================================
// TIME HELPERS — all session logic uses the mode's tzOffsetMinutes (SAST=+120)
// ============================================================================
function localNow(tzOffsetMinutes) {
  return new Date(Date.now() + tzOffsetMinutes * 60000);
}
function localDayKey(tzOffsetMinutes) {
  return localNow(tzOffsetMinutes).toISOString().slice(0, 10); // YYYY-MM-DD in local tz
}
function inWindow(window, tzOffsetMinutes) {
  if (!window || !window.start || !window.end) return true;
  const now = localNow(tzOffsetMinutes);
  const hm = now.toISOString().slice(11, 16); // HH:MM in local tz
  return hm >= window.start && hm < window.end;
}

// ============================================================================
// STATS
// ============================================================================
function modeTrades(mode) {
  return state.closedTrades.filter((t) => t.mode === mode);
}
function modeEquity(mode) {
  const start = state.modes[mode].risk.startingEquity;
  return modeTrades(mode).reduce((eq, t) => eq + t.pnl, start);
}
function todaysClosedPnl(mode) {
  const day = localDayKey(state.modes[mode].risk.tzOffsetMinutes);
  return modeTrades(mode)
    .filter((t) => t.closedDayKey === day)
    .reduce((s, t) => s + t.pnl, 0);
}
function todaysTradeCount(mode) {
  const day = localDayKey(state.modes[mode].risk.tzOffsetMinutes);
  const closed = modeTrades(mode).filter((t) => t.openedDayKey === day).length;
  const open = state.openTrades.filter((t) => t.mode === mode && t.openedDayKey === day).length;
  return closed + open;
}
function equityCurve(mode) {
  const trades = mode
    ? modeTrades(mode)
    : state.closedTrades.slice().sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
  let eq = mode
    ? state.modes[mode].risk.startingEquity
    : Object.keys(state.modes).reduce((s, m) => s + state.modes[m].risk.startingEquity, 0);
  const curve = [{ t: state.createdAt, equity: eq }];
  for (const t of trades) {
    eq += t.pnl;
    curve.push({ t: t.closedAt, equity: eq });
  }
  return curve;
}
function stats(mode) {
  const trades = modeTrades(mode);
  const wins = trades.filter((t) => t.pnl > 0);
  const rr = trades.filter((t) => t.rAchieved != null);
  const curve = equityCurve(mode);
  let peak = -Infinity, maxDD = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    maxDD = Math.max(maxDD, peak > 0 ? ((peak - p.equity) / peak) * 100 : 0);
  }
  const risk = state.modes[mode].risk;
  const dailyPnl = todaysClosedPnl(mode);
  const equity = modeEquity(mode);
  const dailyLossLimit = -(risk.maxDailyLossPct / 100) * equity;
  return {
    trades: trades.length,
    open: state.openTrades.filter((t) => t.mode === mode).length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : null,
    avgRR: rr.length ? rr.reduce((s, t) => s + t.rAchieved, 0) / rr.length : null,
    maxDrawdownPct: maxDD,
    equity,
    dailyPnl,
    dailyLossLimit,
    dailyLossLimitHit: dailyPnl <= dailyLossLimit,
    tradesToday: todaysTradeCount(mode),
  };
}

// ============================================================================
// RISK GATE — mode-specific. Returns { ok, reasons[] }. Never merged across
// modes: each mode's counters, windows, and loss limits are its own.
// ============================================================================
function riskGate(mode, signal) {
  const cfg = state.modes[mode];
  if (!cfg) return { ok: false, reasons: [`Unknown mode "${mode}"`] };
  const risk = cfg.risk;
  const reasons = [];

  if (!risk.enabled) reasons.push("Mode is disabled");

  if (!inWindow(risk.sessionWindow, risk.tzOffsetMinutes)) {
    reasons.push(
      `Outside session window ${risk.sessionWindow.start}–${risk.sessionWindow.end} (UTC${risk.tzOffsetMinutes >= 0 ? "+" : ""}${risk.tzOffsetMinutes / 60})`
    );
  }

  const count = todaysTradeCount(mode);
  if (count >= risk.maxTradesPerDay) {
    reasons.push(
      mode === "gold_session"
        ? `LOCKED OUT: gold session trade already taken today (${count}/${risk.maxTradesPerDay}). Next entry: tomorrow's window.`
        : `Max trades/day reached (${count}/${risk.maxTradesPerDay})`
    );
  }

  const equity = modeEquity(mode);
  const dailyPnl = todaysClosedPnl(mode);
  const limit = -(risk.maxDailyLossPct / 100) * equity;
  if (dailyPnl <= limit) {
    reasons.push(`Max daily loss hit (${dailyPnl.toFixed(2)} ≤ ${limit.toFixed(2)} USD)`);
  }

  // Position sizing
  const stopDistance = Math.abs(signal.entry - signal.stop);
  if (!(stopDistance > 0)) reasons.push("Invalid stop: zero distance from entry");
  const riskUsd = (risk.riskPerTradePct / 100) * equity;
  const size = stopDistance > 0 ? riskUsd / stopDistance : 0;

  return { ok: reasons.length === 0, reasons, size, riskUsd, equity };
}

// ============================================================================
// PAPER EXECUTION — always on, default and only execution path in v1.
// ============================================================================
let tradeSeq = state.closedTrades.length + state.openTrades.length + 1;

function openPaperTrade(mode, signal, gate) {
  const risk = state.modes[mode].risk;
  const trade = {
    id: `T${String(tradeSeq++).padStart(4, "0")}`,
    mode,
    symbol: signal.symbol,
    side: signal.side, // "buy" | "sell"
    entry: signal.entry,
    stop: signal.stop,
    target: signal.target ?? null,
    size: gate.size,
    riskUsd: gate.riskUsd,
    source: signal.source, // "webhook" | "engine" | "manual"
    rule: signal.rule || signal.source,
    reasoning: signal.reasoning || null,
    openedAt: new Date().toISOString(),
    openedDayKey: localDayKey(risk.tzOffsetMinutes),
    status: "open",
    paper: true, // v1: every trade is paper
  };
  state.openTrades.push(trade);

  if (mode === "gold_session") {
    state.goldReasoningLog.unshift({
      at: trade.openedAt,
      tradeId: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      reasoning: signal.reasoning || "(no reasoning supplied by signal source)",
      rule: trade.rule,
    });
    state.goldReasoningLog = state.goldReasoningLog.slice(0, 100);
  }
  saveState();
  return trade;
}

function closeTrade(trade, exitPrice, reason) {
  const dir = trade.side === "buy" ? 1 : -1;
  const pnl = (exitPrice - trade.entry) * dir * trade.size;
  const rAchieved = trade.riskUsd > 0 ? pnl / trade.riskUsd : null;
  const risk = state.modes[trade.mode].risk;
  Object.assign(trade, {
    status: "closed",
    exit: exitPrice,
    pnl,
    rAchieved,
    closeReason: reason,
    closedAt: new Date().toISOString(),
    closedDayKey: localDayKey(risk.tzOffsetMinutes),
  });
  state.openTrades = state.openTrades.filter((t) => t.id !== trade.id);
  state.closedTrades.push(trade);
  saveState();
  return trade;
}

// Price ticks / candles drive SL & TP checks on open trades.
// JUDGMENT CALL: when a candle's range spans BOTH stop and target, we assume
// the STOP was hit first (conservative). Tune if your fills say otherwise.
function processPrice(symbol, price, high = price, low = price) {
  state.lastPrices[symbol] = price;
  for (const trade of [...state.openTrades]) {
    if (trade.symbol !== symbol) continue;
    if (trade.side === "buy") {
      if (low <= trade.stop) closeTrade(trade, trade.stop, "stop_loss");
      else if (trade.target != null && high >= trade.target) closeTrade(trade, trade.target, "take_profit");
    } else {
      if (high >= trade.stop) closeTrade(trade, trade.stop, "stop_loss");
      else if (trade.target != null && low <= trade.target) closeTrade(trade, trade.target, "take_profit");
    }
  }
  saveState();
}

// ============================================================================
// SIGNAL PIPELINE — single funnel for webhook + internal engine + manual.
// ============================================================================
function handleSignal(mode, signal) {
  const gate = riskGate(mode, signal);
  const entry = {
    at: new Date().toISOString(),
    mode,
    symbol: signal.symbol,
    side: signal.side,
    source: signal.source,
    rule: signal.rule || null,
    accepted: gate.ok,
    reasons: gate.reasons,
  };
  state.signalLog.unshift(entry);
  state.signalLog = state.signalLog.slice(0, 300);

  if (!gate.ok) {
    // Gold-session rejections are logged with reasoning too — refining the
    // rule means reviewing what it REFUSED as much as what it took.
    if (mode === "gold_session") {
      state.goldReasoningLog.unshift({
        at: entry.at, tradeId: null, symbol: signal.symbol, side: signal.side,
        reasoning: `REJECTED — ${gate.reasons.join("; ")}. Signal reasoning: ${signal.reasoning || "n/a"}`,
        rule: signal.rule || signal.source,
      });
    }
    saveState();
    return { accepted: false, reasons: gate.reasons };
  }

  const trade = openPaperTrade(mode, signal, gate);
  entry.tradeId = trade.id;
  saveState();
  return { accepted: true, trade };
}

// ============================================================================
// INTERNAL SIGNAL ENGINE — Break of Structure + Retest
//
// State machine per (mode, symbol):  SCANNING → BROKEN → (confirmed) SIGNAL
//
// Every threshold below is a JUDGMENT CALL surfaced in state.engine so you
// can tune it against your own chart reading. The big ones:
//
//  [J1] Block detection: the "range" = highest high / lowest low over
//       `lookback` bars, valid only if height ≤ maxRangeHeightPct of price
//       AND each edge was touched ≥ minTouches times (a touch = a bar's
//       high/low within touchTolerancePct of the range height from the edge).
//       Alternative you may prefer: pivot-cluster detection. This version
//       favors simplicity and explainability over cleverness.
//
//  [J2] Break definition: a CLOSE beyond the edge by breakBufferPct of the
//       range height. Wick-only pokes do NOT count as breaks — they count
//       as touches. If your instruments break on wicks, lower breakBufferPct
//       and switch the check to high/low.
//
//  [J3] Retest: any bar whose low (bullish) / high (bearish) comes back
//       within retestTolerancePct of range height from the broken edge,
//       within maxBarsToRetest bars. Deeper re-entry THROUGH the level by
//       more than the tolerance invalidates the setup (failed break).
//
//  [J4] Confirmation candle, three selectable definitions:
//       - close_direction: candle closes in the break direction, beyond its
//         own midpoint (body shows intent).
//       - engulfing: body engulfs the prior candle's body.
//       - rejection_wick: wick into the level ≥ 2× body, closing away.
//
//  [J5] Stop placement: beyond the retest candle's extreme (tight) or the
//       far edge of the block (roomy), plus stopBufferPct.
// ============================================================================
function engineKey(mode, symbol) {
  return `${mode}:${symbol}`;
}

function detectRange(candles, cfg) {
  const window = candles.slice(-cfg.lookback);
  if (window.length < Math.max(10, cfg.minTouches * 2)) return null;
  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  const height = high - low;
  const mid = (high + low) / 2;
  if (mid <= 0 || (height / mid) * 100 > cfg.maxRangeHeightPct) return null; // [J1] too tall = trend, not block

  const tol = height * (cfg.touchTolerancePct / 100);
  const topTouches = window.filter((c) => high - c.high <= tol).length;
  const botTouches = window.filter((c) => c.low - low <= tol).length;
  if (topTouches < cfg.minTouches || botTouches < cfg.minTouches) return null;

  return { high, low, height, topTouches, botTouches };
}

function confirms(candle, prev, direction, cfg) {
  const body = Math.abs(candle.close - candle.open);
  const bullish = candle.close > candle.open;
  const dirOk = direction === "up" ? bullish : !bullish;
  switch (cfg.confirmation) {
    case "engulfing": {
      if (!prev) return false;
      const prevBody = Math.abs(prev.close - prev.open);
      return dirOk && body > prevBody &&
        Math.min(candle.open, candle.close) <= Math.min(prev.open, prev.close) &&
        Math.max(candle.open, candle.close) >= Math.max(prev.open, prev.close);
    }
    case "rejection_wick": {
      const wick = direction === "up"
        ? Math.min(candle.open, candle.close) - candle.low
        : candle.high - Math.max(candle.open, candle.close);
      return dirOk && body > 0 && wick >= 2 * body;
    }
    case "close_direction":
    default: {
      const range = candle.high - candle.low;
      const midpoint = candle.low + range / 2;
      return dirOk && (direction === "up" ? candle.close > midpoint : candle.close < midpoint);
    }
  }
}

function runEngine(mode, symbol) {
  const cfg = state.engine;
  const key = engineKey(mode, symbol);
  const candles = state.candles[key] || [];
  if (candles.length < 5) return null;
  const es = state.engineStates[key] || { phase: "SCANNING" };
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  if (es.phase === "SCANNING") {
    const range = detectRange(candles.slice(0, -1), cfg); // block from bars BEFORE the break candle
    if (range) {
      const buffer = range.height * (cfg.breakBufferPct / 100);
      if (last.close > range.high + buffer) {
        Object.assign(es, { phase: "BROKEN", direction: "up", level: range.high, range, barsSinceBreak: 0 });
      } else if (last.close < range.low - buffer) {
        Object.assign(es, { phase: "BROKEN", direction: "down", level: range.low, range, barsSinceBreak: 0 });
      }
    }
  } else if (es.phase === "BROKEN") {
    es.barsSinceBreak++;
    const tol = es.range.height * (cfg.retestTolerancePct / 100);
    const invalidated = es.direction === "up"
      ? last.close < es.level - tol
      : last.close > es.level + tol;
    if (invalidated) {
      Object.assign(es, { phase: "SCANNING", note: "failed break — closed back through level" });
    } else if (es.barsSinceBreak > cfg.maxBarsToRetest) {
      Object.assign(es, { phase: "SCANNING", note: "break expired without retest" });
    } else {
      const touchedLevel = es.direction === "up"
        ? last.low <= es.level + tol
        : last.high >= es.level - tol;
      if (touchedLevel && confirms(last, prev, es.direction, cfg)) {
        // SIGNAL — assemble entry/stop/target
        const entry = last.close;
        const stopAnchor = cfg.stopPlacement === "block_far_edge"
          ? (es.direction === "up" ? es.range.low : es.range.high)
          : (es.direction === "up" ? last.low : last.high);
        const buf = es.range.height * (cfg.stopBufferPct / 100);
        const stop = es.direction === "up" ? stopAnchor - buf : stopAnchor + buf;
        const riskDist = Math.abs(entry - stop);
        const target = es.direction === "up" ? entry + riskDist * cfg.targetRR : entry - riskDist * cfg.targetRR;
        const reasoning =
          `BOS+Retest [${symbol}] block ${es.range.low.toFixed(5)}–${es.range.high.toFixed(5)} ` +
          `(${es.range.topTouches}↑/${es.range.botTouches}↓ touches), broke ${es.direction} through ` +
          `${es.level.toFixed(5)}, retested within ${cfg.retestTolerancePct}% of range height after ` +
          `${es.barsSinceBreak} bars, confirmed by ${cfg.confirmation} candle. Stop: ${cfg.stopPlacement}.`;

        state.engineStates[key] = { phase: "SCANNING", note: "signal fired" };
        saveState();
        return {
          source: "engine",
          rule: "bos_retest",
          symbol,
          side: es.direction === "up" ? "buy" : "sell",
          entry, stop, target, reasoning,
        };
      }
    }
  }
  state.engineStates[key] = es;
  saveState();
  return null;
}

// ============================================================================
// ROUTES
// ============================================================================
app.get("/api/health", (req, res) => {
  res.json({ ok: true, app: "TradeForge", paperMode: true, liveExecutionWired: false, hasApiKey: !!ANTHROPIC_API_KEY });
});

// Full dashboard state
app.get("/api/state", (req, res) => {
  const modes = {};
  for (const m of Object.keys(state.modes)) {
    modes[m] = {
      ...state.modes[m],
      stats: stats(m),
      inWindow: inWindow(state.modes[m].risk.sessionWindow, state.modes[m].risk.tzOffsetMinutes),
    };
  }
  res.json({
    paperMode: true,
    exchangeRate: state.exchangeRate,
    engine: state.engine,
    engineStates: state.engineStates,
    modes,
    openTrades: state.openTrades,
    closedTrades: state.closedTrades.slice(-200),
    signalLog: state.signalLog.slice(0, 100),
    goldReasoningLog: state.goldReasoningLog.slice(0, 50),
    combinedCurve: equityCurve(null),
    curves: Object.fromEntries(Object.keys(state.modes).map((m) => [m, equityCurve(m)])),
    lastPrices: state.lastPrices,
  });
});

// Update mode risk settings / engine config / exchange rate
app.post("/api/config", (req, res) => {
  const { exchangeRate, engine, modes } = req.body || {};
  if (typeof exchangeRate === "number" && exchangeRate > 0) state.exchangeRate = exchangeRate;
  if (engine && typeof engine === "object") Object.assign(state.engine, engine);
  if (modes && typeof modes === "object") {
    for (const [m, cfg] of Object.entries(modes)) {
      if (state.modes[m] && cfg.risk) Object.assign(state.modes[m].risk, cfg.risk);
    }
  }
  saveState();
  res.json({ ok: true });
});

// --------------------------------------------------------------------------
// TRADINGVIEW WEBHOOK — primary signal source.
// Point TradingView alerts at:  POST https://yourapp.up.railway.app/webhook/tradingview
// Alert message (JSON):
// {
//   "secret": "<WEBHOOK_SECRET>",
//   "mode": "day",                     // scalp | day | swing | gold_session
//   "symbol": "{{ticker}}",
//   "side": "buy",                     // buy | sell
//   "entry": {{close}},
//   "stop": 2315.5,                    // required — sizing is derived from it
//   "target": 2340.0,                  // optional; omit to manage manually
//   "reasoning": "15m BOS retest at London open"   // optional but recommended
// }
// --------------------------------------------------------------------------
app.post("/webhook/tradingview", (req, res) => {
  const b = req.body || {};
  if (b.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret" });
  const required = ["mode", "symbol", "side", "entry", "stop"];
  const missing = required.filter((k) => b[k] == null);
  if (missing.length) return res.status(400).json({ error: `Missing fields: ${missing.join(", ")}` });
  if (!["buy", "sell"].includes(b.side)) return res.status(400).json({ error: "side must be buy|sell" });

  const result = handleSignal(b.mode, {
    source: "webhook",
    rule: b.rule || "tradingview_alert",
    symbol: String(b.symbol).toUpperCase(),
    side: b.side,
    entry: Number(b.entry),
    stop: Number(b.stop),
    target: b.target != null ? Number(b.target) : null,
    reasoning: b.reasoning || null,
  });
  res.status(result.accepted ? 200 : 409).json(result);
});

// --------------------------------------------------------------------------
// CANDLE INGEST — feeds the internal BOS/retest engine AND SL/TP tracking.
// POST /api/candles  { mode, symbol, candles: [{time, open, high, low, close}] }
// Wire a price feed here (e.g. an n8n/Make cron pulling Twelve Data or a
// broker's REST candles every bar close), or replay history to test tuning.
// --------------------------------------------------------------------------
app.post("/api/candles", (req, res) => {
  const { mode, symbol, candles } = req.body || {};
  if (!state.modes[mode]) return res.status(400).json({ error: "Unknown mode" });
  if (!symbol || !Array.isArray(candles) || !candles.length)
    return res.status(400).json({ error: "symbol and candles[] required" });

  const key = engineKey(mode, String(symbol).toUpperCase());
  const store = state.candles[key] || [];
  const signals = [];
  for (const c of candles) {
    store.push({ time: c.time || new Date().toISOString(), open: +c.open, high: +c.high, low: +c.low, close: +c.close });
    if (store.length > 500) store.shift();
    state.candles[key] = store;
    processPrice(String(symbol).toUpperCase(), +c.close, +c.high, +c.low); // manage open trades
    const sig = runEngine(mode, String(symbol).toUpperCase());
    if (sig) signals.push({ signal: sig, result: handleSignal(mode, sig) });
  }
  saveState();
  res.json({ ok: true, barsStored: store.length, signalsFired: signals });
});

// Simple price tick (no candle) — for SL/TP tracking of open trades
app.post("/api/price", (req, res) => {
  const { symbol, price } = req.body || {};
  if (!symbol || typeof price !== "number") return res.status(400).json({ error: "symbol and numeric price required" });
  processPrice(String(symbol).toUpperCase(), price);
  res.json({ ok: true });
});

// Manual signal entry (testing / discretionary paper trades)
app.post("/api/signal/manual", (req, res) => {
  const b = req.body || {};
  const result = handleSignal(b.mode, {
    source: "manual",
    rule: b.rule || "manual",
    symbol: String(b.symbol || "").toUpperCase(),
    side: b.side,
    entry: Number(b.entry),
    stop: Number(b.stop),
    target: b.target != null ? Number(b.target) : null,
    reasoning: b.reasoning || "Manual entry from dashboard",
  });
  res.status(result.accepted ? 200 : 409).json(result);
});

// Manual close of an open trade at a given price
app.post("/api/trades/:id/close", (req, res) => {
  const trade = state.openTrades.find((t) => t.id === req.params.id);
  if (!trade) return res.status(404).json({ error: "Open trade not found" });
  const price = Number(req.body?.price);
  if (!(price > 0)) return res.status(400).json({ error: "Numeric close price required" });
  res.json({ ok: true, trade: closeTrade(trade, price, "manual_close") });
});

// Reset paper history for a mode (keeps config)
app.post("/api/reset/:mode", (req, res) => {
  const m = req.params.mode;
  if (!state.modes[m]) return res.status(400).json({ error: "Unknown mode" });
  state.openTrades = state.openTrades.filter((t) => t.mode !== m);
  state.closedTrades = state.closedTrades.filter((t) => t.mode !== m);
  if (m === "gold_session") state.goldReasoningLog = [];
  saveState();
  res.json({ ok: true });
});

// ============================================================================
// [STUB] LIVE EXECUTION — 501 by default. DO NOT wire until paper results
// have proven the rules over a meaningful sample. Same stub pattern as the
// Shopify/Meta stubs in DropForge/LeadForge: frontend already calls these
// and renders the 501 gracefully; wiring them requires NO frontend changes.
// ============================================================================

// ---- OANDA (forex + gold CFDs) --------------------------------------------
// WIRING INSTRUCTIONS:
// 1. Create an OANDA fxTrade PRACTICE account first; get API token + account ID.
// 2. Set env vars: OANDA_API_TOKEN, OANDA_ACCOUNT_ID, OANDA_ENV=practice|live
// 3. Uncomment the implementation below. Order endpoint:
//    POST https://api-fx{practice|trade}.oanda.com/v3/accounts/{id}/orders
//    Body: { order: { type: "MARKET", instrument: "XAU_USD",
//            units: signedUnits, stopLossOnFill: { price }, takeProfitOnFill: { price } } }
// 4. Flip trade.paper = false ONLY on confirmed fill response.
app.post("/api/live/oanda/order", (req, res) => {
  res.status(501).json({
    error: "Live execution not wired (by design in v1)",
    broker: "OANDA",
    wiring: "See commented instructions above this route in server.js",
  });
  /*
  const token = process.env.OANDA_API_TOKEN;
  const acct = process.env.OANDA_ACCOUNT_ID;
  const env = process.env.OANDA_ENV === "live" ? "fxtrade" : "fxpractice";
  const { instrument, units, stop, target } = req.body;
  const r = await fetch(`https://api-${env}.oanda.com/v3/accounts/${acct}/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ order: {
      type: "MARKET", instrument, units: String(units), timeInForce: "FOK",
      stopLossOnFill: { price: String(stop) },
      ...(target ? { takeProfitOnFill: { price: String(target) } } : {}),
    }}),
  });
  res.status(r.status).json(await r.json());
  */
});

// ---- Deriv (synthetic indices / binary-adjacent — check product fit first) -
// WIRING INSTRUCTIONS:
// 1. Create a Deriv DEMO account; generate an API token (trade scope).
// 2. Deriv uses a WebSocket API (wss://ws.derivws.com/websockets/v3?app_id=...),
//    not REST — add the "ws" npm package, open a socket on boot, authorize
//    with the token, then send `buy` / `proposal` messages here.
// 3. Set env vars: DERIV_APP_ID, DERIV_API_TOKEN.
app.post("/api/live/deriv/order", (req, res) => {
  res.status(501).json({
    error: "Live execution not wired (by design in v1)",
    broker: "Deriv",
    wiring: "WebSocket API — see commented instructions above this route in server.js",
  });
});

// ============================================================================
// CLAUDE PROXY (optional) — reasoning over the day's setups. The trading
// pipeline never depends on this; it is analysis-only.
// ============================================================================
app.post("/api/claude", async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: "ANTHROPIC_API_KEY not set — AI review disabled. Core trading logic is unaffected." });
  try {
    const { messages, system, max_tokens } = req.body || {};
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", // whitelisted; ignore any model in the request
        max_tokens: Math.min(max_tokens || 1500, 4000),
        ...(system ? { system } : {}),
        messages: Array.isArray(messages) ? messages : [],
      }),
    });
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`TradeForge listening on :${PORT} — PAPER MODE (live execution stubbed)`);
});
