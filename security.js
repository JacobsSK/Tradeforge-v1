// ============================================================================
// security.js — shared lock for the Forge apps
// ----------------------------------------------------------------------------
// 1. App password: every /api/* route needs the header `x-app-password`
//    matching APP_PASSWORD (Railway → Variables). /api/health stays open so
//    the front page can still detect the server. Routes outside /api (like
//    /webhook/tradingview) are not touched here; they keep their own secret.
//    If APP_PASSWORD is not set, protected routes refuse everything (503).
// 2. Wrong-password limit: 10 wrong tries per visitor per 15 minutes.
// 3. AI rate limit: AI_LIMIT_PER_HOUR per visitor (default 30) and
//    AI_LIMIT_PER_DAY for the whole app (default 300).
// 4. Locked AI call: lockedClaudeBody() builds the Anthropic request on the
//    server with a fixed model and a fixed max reply length. Only `system`
//    and `messages` are taken from the browser; everything else is ignored.
// 5. Serves /auth.js — the small front-page script that asks for the
//    password once and adds it to every /api call.
//
// No secret lives in this file. All secrets come from Railway Variables.
// ============================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOUR = 60 * 60 * 1000;
const PUBLIC_API_PATHS = new Set(['/api/health']);
const AUTH_CHECK_PATH = '/api/auth/check';
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_MAX = 10;

function positiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Compare two strings in constant time (hashing first makes lengths equal).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Visitor id = IP address. Railway's edge adds the real client IP as the
// LAST entry of X-Forwarded-For; earlier entries can be faked by the client.
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '');
  const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ---------------------------------------------------------------- failures
const failures = new Map(); // ip -> { start, count }

function isLockedOut(ip) {
  const f = failures.get(ip);
  return Boolean(f && Date.now() - f.start < FAIL_WINDOW_MS && f.count >= FAIL_MAX);
}

function noteFailure(ip) {
  const now = Date.now();
  let f = failures.get(ip);
  if (!f || now - f.start >= FAIL_WINDOW_MS) f = { start: now, count: 0 };
  f.count += 1;
  failures.set(ip, f);
}

// ---------------------------------------------------------------- password
function requirePassword(req, res, next) {
  // Express matches routes case-insensitively, so compare in lower case.
  const p = req.path.toLowerCase();
  if (!p.startsWith('/api/') || PUBLIC_API_PATHS.has(p)) return next();

  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    return res.status(503).json({
      error: 'app_locked',
      message: 'This app is locked: APP_PASSWORD is not set in Railway → Variables.',
    });
  }

  const ip = clientIp(req);
  if (isLockedOut(ip)) {
    return res.status(429).json({
      error: 'too_many_attempts',
      message: 'Too many wrong passwords. Wait 15 minutes and try again.',
    });
  }

  if (!safeEqual(String(req.headers['x-app-password'] || ''), expected)) {
    noteFailure(ip);
    return res.status(401).json({ error: 'password_required', message: 'Wrong or missing app password.' });
  }

  if (p === AUTH_CHECK_PATH) return res.json({ ok: true });
  next();
}

// ---------------------------------------------------------------- AI limit
const aiHits = new Map(); // ip -> [timestamps in the last hour]
let dayStart = Date.now();
let dayCount = 0;

function aiLimit(req, res, next) {
  const perHour = positiveInt(process.env.AI_LIMIT_PER_HOUR, 30);
  const perDay = positiveInt(process.env.AI_LIMIT_PER_DAY, 300);
  const now = Date.now();

  if (now - dayStart >= 24 * HOUR) { dayStart = now; dayCount = 0; }
  if (dayCount >= perDay) {
    return res.status(429).json({
      error: 'daily_ai_limit',
      message: `This app has used its ${perDay} AI requests for today. Try again tomorrow.`,
    });
  }

  const ip = clientIp(req);
  const hits = (aiHits.get(ip) || []).filter((t) => now - t < HOUR);
  if (hits.length >= perHour) {
    const waitMin = Math.ceil((HOUR - (now - hits[0])) / 60000);
    aiHits.set(ip, hits);
    return res.status(429).json({
      error: 'ai_rate_limited',
      message: `AI limit reached (${perHour} requests per hour). Try again in about ${waitMin} minute(s).`,
    });
  }
  hits.push(now);
  aiHits.set(ip, hits);
  dayCount += 1;
  next();
}

// Clear old entries so memory doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of aiHits) if (!hits.some((t) => now - t < HOUR)) aiHits.delete(ip);
  for (const [ip, f] of failures) if (now - f.start >= FAIL_WINDOW_MS) failures.delete(ip);
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------- AI body
// Builds the request we send to Anthropic. Model and max_tokens are fixed
// by the server; any model, max_tokens, tools, etc. from the browser are
// dropped. Returns null if there are no messages.
function lockedClaudeBody(body, { model, maxTokens }) {
  const b = body && typeof body === 'object' ? body : {};
  if (!Array.isArray(b.messages) || b.messages.length === 0) return null;
  const out = { model, max_tokens: maxTokens, messages: b.messages };
  if (typeof b.system === 'string' || Array.isArray(b.system)) out.system = b.system;
  return out;
}

// ---------------------------------------------------------------- install
const AUTH_JS = path.join(__dirname, 'auth.js');

function install(app) {
  app.get('/auth.js', (req, res) => {
    res.type('application/javascript');
    res.set('Cache-Control', 'no-cache');
    res.sendFile(AUTH_JS);
  });
  app.use(requirePassword);
  if (!process.env.APP_PASSWORD) {
    console.warn('[security] APP_PASSWORD is not set: all /api routes except /api/health are refused.');
  }
}

// Finds the folder that holds the front page (some repos use "Public").
function findPageDir(rootDir) {
  for (const name of ['public', 'Public']) {
    if (fs.existsSync(path.join(rootDir, name, 'index.html'))) return path.join(rootDir, name);
  }
  return null;
}

module.exports = { install, requirePassword, aiLimit, lockedClaudeBody, safeEqual, clientIp, isLockedOut, noteFailure, findPageDir };
