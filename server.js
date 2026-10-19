const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const Database = require("better-sqlite3");
const { sendSms, smsConfigured, getBalance } = require("./lib/sms");

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production";
// Railway에 볼륨을 붙이면 RAILWAY_VOLUME_MOUNT_PATH가 자동으로 생겨서, 따로 DATA_DIR을 안 넣어도 그 경로에 저장합니다.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
// Railway에서 볼륨 없이 돌고 있으면 재배포 때 데이터가 지워집니다. 관리자 화면에 경고를 띄웁니다.
const DATA_NOT_PERSISTENT = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) &&
  !process.env.RAILWAY_VOLUME_MOUNT_PATH;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
// 신청자에게 문자로 보내는 수강 안내 페이지 주소 (public/info.html)
const INFO_URL = process.env.INFO_URL || "aieo.kr/info";
// 새 신청이 들어오면 알림 문자를 받을 번호 (여러 개는 쉼표로 구분)
const ADMIN_PHONES = (process.env.ADMIN_PHONE || "").split(",").map((p) => p.replace(/\D/g, "")).filter(Boolean);

const CODE_TTL_MS = 3 * 60 * 1000; // 인증번호 유효시간 3분
const RESEND_COOLDOWN_MS = 60 * 1000; // 같은 번호 재발송 대기 1분
const MAX_SENDS_PER_HOUR = 5; // 번호당 시간당 발송 횟수
const MAX_SENDS_PER_IP_HOUR = 20; // IP당 시간당 발송 횟수
const MAX_VERIFY_ATTEMPTS = 5;
const TOKEN_TTL_MS = 30 * 60 * 1000; // 인증 후 신청까지 30분

// ── 일정 ──────────────────────────────────────────────
// 일정은 관리자 페이지에서 관리합니다(DB의 slots 테이블). 처음 실행할 때만 schedule.json으로 채웁니다.
function loadSchedule() {
  return q.allSlots.all().map((s) => ({ ...s, open: Boolean(s.open) }));
}

function startsAt(slot) {
  return new Date(`${slot.date}T${slot.start}:00+09:00`).getTime();
}

// ── DB ───────────────────────────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "signups.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slot_id TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    memo TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (slot_id, phone)
  );
  CREATE TABLE IF NOT EXISTS codes (
    phone TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sends (
    phone TEXT NOT NULL,
    ip TEXT NOT NULL,
    sent_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS slots (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    place TEXT NOT NULL,
    capacity INTEGER NOT NULL DEFAULT 6,
    open INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    vid TEXT NOT NULL,
    source TEXT NOT NULL,
    referrer TEXT
  );
  CREATE INDEX IF NOT EXISTS visits_ts ON visits (ts);
  CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

const q = {
  allSlots: db.prepare("SELECT * FROM slots ORDER BY date, start"),
  getSlot: db.prepare("SELECT * FROM slots WHERE id = ?"),
  insertSlot: db.prepare(
    "INSERT INTO slots (id, date, start, end, place, capacity, open) VALUES (@id, @date, @start, @end, @place, @capacity, @open)"
  ),
  updateSlot: db.prepare(
    "UPDATE slots SET date = @date, start = @start, end = @end, place = @place, capacity = @capacity, open = @open WHERE id = @id"
  ),
  deleteSlot: db.prepare("DELETE FROM slots WHERE id = ?"),
  insertVisit: db.prepare("INSERT INTO visits (ts, vid, source, referrer) VALUES (?, ?, ?, ?)"),
  visitsSince: db.prepare("SELECT ts, vid, source, referrer FROM visits WHERE ts >= ?"),
  signupsSince: db.prepare("SELECT created_at FROM signups WHERE created_at >= ?"),
  countBySlot: db.prepare("SELECT slot_id, COUNT(*) AS n FROM signups GROUP BY slot_id"),
  countSlot: db.prepare("SELECT COUNT(*) AS n FROM signups WHERE slot_id = ?"),
  insertSignup: db.prepare(
    "INSERT INTO signups (slot_id, name, phone, memo, created_at) VALUES (?, ?, ?, ?, ?)"
  ),
  findSignup: db.prepare("SELECT id FROM signups WHERE slot_id = ? AND phone = ?"),
  listSignups: db.prepare("SELECT * FROM signups ORDER BY slot_id, created_at"),
  deleteSignup: db.prepare("DELETE FROM signups WHERE id = ?"),
  lastSend: db.prepare("SELECT MAX(sent_at) AS t FROM sends WHERE phone = ?"),
  sendsByPhone: db.prepare("SELECT COUNT(*) AS n FROM sends WHERE phone = ? AND sent_at > ?"),
  sendsByIp: db.prepare("SELECT COUNT(*) AS n FROM sends WHERE ip = ? AND sent_at > ?"),
  logSend: db.prepare("INSERT INTO sends (phone, ip, sent_at) VALUES (?, ?, ?)"),
  pruneSends: db.prepare("DELETE FROM sends WHERE sent_at < ?"),
  upsertCode: db.prepare(
    "INSERT INTO codes (phone, code, expires_at, attempts) VALUES (?, ?, ?, 0) " +
      "ON CONFLICT(phone) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0"
  ),
  getCode: db.prepare("SELECT * FROM codes WHERE phone = ?"),
  bumpAttempts: db.prepare("UPDATE codes SET attempts = attempts + 1 WHERE phone = ?"),
  deleteCode: db.prepare("DELETE FROM codes WHERE phone = ?"),
  insertToken: db.prepare("INSERT INTO tokens (token, phone, expires_at) VALUES (?, ?, ?)"),
  getToken: db.prepare("SELECT * FROM tokens WHERE token = ?"),
  deleteToken: db.prepare("DELETE FROM tokens WHERE token = ?"),
  pruneTokens: db.prepare("DELETE FROM tokens WHERE expires_at < ?"),
};

if (db.prepare("SELECT COUNT(*) AS n FROM slots").get().n === 0) {
  const seedPath = path.join(__dirname, "schedule.json");
  if (fs.existsSync(seedPath)) {
    for (const s of JSON.parse(fs.readFileSync(seedPath, "utf8"))) {
      q.insertSlot.run({ capacity: 6, ...s, open: 1 });
    }
  }
}

// 정원 확인과 저장을 한 트랜잭션으로 묶어 동시에 신청해도 6명을 넘지 않게 합니다.
const applyTx = db.transaction((slot, name, phone, memo) => {
  if (q.findSignup.get(slot.id, phone)) return "duplicate";
  if (q.countSlot.get(slot.id).n >= slot.capacity) return "full";
  q.insertSignup.run(slot.id, name, phone, memo, Date.now());
  return "ok";
});

// ── 유틸 ─────────────────────────────────────────────
function normalizePhone(input) {
  const digits = String(input || "").replace(/\D/g, "");
  return /^01[016789]\d{7,8}$/.test(digits) ? digits : null;
}

// 유입 경로: Referer 헤더, utm_source, 앱 내 브라우저(UA)로 판단합니다.
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|kakaotalk-scrap|preview|headless|curl|wget/i;
function classifySource(req) {
  const utm = String(req.query.utm_source || "").trim().slice(0, 40);
  if (utm) return utm;
  const ua = req.get("user-agent") || "";
  if (/KAKAOTALK/i.test(ua)) return "카카오톡";
  if (/Instagram/i.test(ua)) return "인스타그램";
  if (/FBAN|FBAV/i.test(ua)) return "페이스북";
  if (/NAVER\(inapp/i.test(ua)) return "네이버 앱";
  if (/Threads|Barcelona/i.test(ua)) return "스레드";
  const ref = req.get("referer") || "";
  let host = "";
  try { host = new URL(ref).hostname.replace(/^www\./, ""); } catch {}
  if (!host || host === req.hostname) return "직접 방문";
  if (/naver\./.test(host)) return "네이버";
  if (/google\./.test(host)) return "구글";
  if (/daum\.|kakao\./.test(host)) return host.includes("kakao") ? "카카오" : "다음";
  if (/instagram\./.test(host)) return "인스타그램";
  if (/facebook\.|fb\./.test(host)) return "페이스북";
  if (/threads\./.test(host)) return "스레드";
  if (/youtube\.|youtu\.be/.test(host)) return "유튜브";
  if (/t\.co$|twitter\.|x\.com/.test(host)) return "X(트위터)";
  return host;
}

function trackVisit(req, res) {
  if (BOT_RE.test(req.get("user-agent") || "")) return;
  const cookies = Object.fromEntries((req.get("cookie") || "").split(/;\s*/).filter(Boolean)
    .map((c) => { const i = c.indexOf("="); return [c.slice(0, i), c.slice(i + 1)]; }));
  let vid = /^[a-f0-9]{24}$/.test(cookies.vid || "") ? cookies.vid : null;
  if (!vid) {
    vid = crypto.randomBytes(12).toString("hex");
    res.cookie("vid", vid, { maxAge: 365 * 24 * 3600 * 1000, httpOnly: true, sameSite: "lax", secure: req.secure });
  }
  const ref = (req.get("referer") || "").slice(0, 300);
  q.insertVisit.run(Date.now(), vid, classifySource(req), ref || null);
}

function kstDay(ts) {
  return new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 문자용 짧은 일정 표기: 11/14(토)14:00
function shortSlot(slot) {
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const [, m, dd] = slot.date.split("-");
  return `${Number(m)}/${Number(dd)}(${days[new Date(`${slot.date}T12:00:00Z`).getUTCDay()]})${slot.start}`;
}

function formatSlot(slot) {
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const [, m, dd] = slot.date.split("-");
  const day = days[new Date(`${slot.date}T12:00:00Z`).getUTCDay()];
  return `${Number(m)}월 ${Number(dd)}일(${day}) ${slot.start}~${slot.end}`;
}

// ── 앱 ───────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "10kb" }));
// 카카오톡·페이스북 등은 미리보기 이미지 주소를 절대 경로로 요구해서, 접속한 도메인을 붙여 내려줍니다.
const indexHtml = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
app.get(["/", "/index.html"], (req, res) => {
  try { trackVisit(req, res); } catch (e) { console.error("visit log error", e); }
  const origin = `${req.protocol}://${req.get("host")}`;
  res.type("html").send(indexHtml.replaceAll('content="/og.png"', `content="${origin}/og.png"`));
});
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] })); // /info → info.html

app.get("/api/slots", (req, res) => {
  const counts = Object.fromEntries(q.countBySlot.all().map((r) => [r.slot_id, r.n]));
  const now = Date.now();
  const slots = loadSchedule()
    .filter((s) => s.open && startsAt(s) > now - 24 * 60 * 60 * 1000)
    .sort((a, b) => startsAt(a) - startsAt(b))
    .map((s) => {
      const taken = counts[s.id] || 0;
      return {
        id: s.id,
        date: s.date,
        start: s.start,
        end: s.end,
        place: s.place,
        capacity: s.capacity,
        remaining: Math.max(0, s.capacity - taken),
        closed: startsAt(s) <= now,
      };
    });
  res.json({ slots });
});

app.post("/api/send-code", async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: "휴대폰 번호를 정확히 입력해 주세요." });

  const now = Date.now();
  q.pruneSends.run(now - 60 * 60 * 1000);
  const last = q.lastSend.get(phone).t;
  if (last && now - last < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - last)) / 1000);
    return res.status(429).json({ error: `${wait}초 후에 다시 요청해 주세요.` });
  }
  if (q.sendsByPhone.get(phone, now - 3600_000).n >= MAX_SENDS_PER_HOUR ||
      q.sendsByIp.get(req.ip, now - 3600_000).n >= MAX_SENDS_PER_IP_HOUR) {
    return res.status(429).json({ error: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요." });
  }

  const code = String(crypto.randomInt(100000, 1000000));
  q.upsertCode.run(phone, code, now + CODE_TTL_MS);
  q.logSend.run(phone, req.ip, now);

  if (!smsConfigured()) {
    if (IS_PROD) return res.status(503).json({ error: "문자 발송 설정이 아직 안 되어 있어요." });
    // 로컬 개발용: 솔라피 키가 없으면 문자 대신 콘솔과 응답으로 인증번호를 알려줍니다.
    console.log(`[DEV] ${phone} 인증번호: ${code}`);
    return res.json({ success: true, devCode: code });
  }

  try {
    await sendSms(phone, `[바이브코딩] 인증번호 ${code} (3분 내 입력)`);
    res.json({ success: true });
  } catch (e) {
    q.deleteCode.run(phone);
    res.status(502).json({ error: "문자 발송에 실패했어요. 잠시 후 다시 시도해 주세요." });
  }
});

app.post("/api/verify-code", (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const code = String(req.body.code || "").trim();
  const row = phone && q.getCode.get(phone);
  if (!row) return res.status(400).json({ error: "인증번호를 먼저 요청해 주세요." });
  if (row.expires_at < Date.now()) {
    q.deleteCode.run(phone);
    return res.status(400).json({ error: "인증번호가 만료됐어요. 다시 요청해 주세요." });
  }
  if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
    q.deleteCode.run(phone);
    return res.status(429).json({ error: "입력 횟수를 넘었어요. 인증번호를 다시 요청해 주세요." });
  }
  const ok = code.length === row.code.length &&
    crypto.timingSafeEqual(Buffer.from(code), Buffer.from(row.code));
  if (!ok) {
    q.bumpAttempts.run(phone);
    return res.status(400).json({ error: "인증번호가 맞지 않아요." });
  }
  q.deleteCode.run(phone);
  q.pruneTokens.run(Date.now());
  const token = crypto.randomBytes(24).toString("hex");
  q.insertToken.run(token, phone, Date.now() + TOKEN_TTL_MS);
  res.json({ success: true, token });
});

app.post("/api/apply", async (req, res) => {
  const { slotId, token } = req.body;
  const name = String(req.body.name || "").trim().slice(0, 30);
  const memo = String(req.body.memo || "").trim().slice(0, 300);
  if (!name) return res.status(400).json({ error: "이름을 입력해 주세요." });

  const t = token && q.getToken.get(String(token));
  if (!t || t.expires_at < Date.now()) {
    return res.status(401).json({ error: "휴대폰 인증이 필요해요. 다시 인증해 주세요." });
  }

  const slot = loadSchedule().find((s) => s.id === slotId);
  if (!slot || !slot.open) return res.status(400).json({ error: "일정을 다시 선택해 주세요." });
  if (startsAt(slot) <= Date.now()) return res.status(400).json({ error: "이미 지난 일정이에요." });

  const result = applyTx(slot, name, t.phone, memo);
  if (result === "duplicate") return res.status(409).json({ error: "이 번호로 이미 신청한 일정이에요." });
  if (result === "full") return res.status(409).json({ error: "아쉽게도 방금 마감됐어요. 다른 일정을 선택해 주세요." });

  q.deleteToken.run(t.token);

  if (smsConfigured()) {
    sendSms(t.phone, `[바이브코딩] ${name.slice(0, 5)}님 ${shortSlot(slot)} 신청 완료. 안내: ${INFO_URL}`)
      .catch(() => {}); // 확인 문자는 실패해도 신청은 유지
    const taken = q.countSlot.get(slot.id).n;
    const fmtPhone = t.phone.replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1-$2-$3");
    const note = `[새신청] ${name.slice(0, 5)} ${fmtPhone} ${shortSlot(slot)} ${taken}/${slot.capacity}명`;
    for (const to of ADMIN_PHONES) sendSms(to, note).catch(() => {});
  }
  res.json({ success: true, slot: { ...slot, label: formatSlot(slot) } });
});

// ── 관리자 ─────────────────────────────────────────
const adminFails = new Map(); // IP별 비밀번호 실패 횟수 (10분에 10번까지)
function requireAdmin(req, res, next) {
  const now = Date.now();
  const f = adminFails.get(req.ip);
  if (f && f.until > now && f.n >= 10) {
    return res.status(429).json({ error: "비밀번호를 너무 많이 틀렸어요. 10분 뒤에 다시 시도해 주세요." });
  }
  const key = req.get("x-admin-key") || "";
  if (!ADMIN_KEY || key.length !== ADMIN_KEY.length ||
      !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY))) {
    const cur = f && f.until > now ? f : { n: 0, until: now + 10 * 60 * 1000 };
    cur.n++;
    adminFails.set(req.ip, cur);
    return res.status(401).json({ error: ADMIN_KEY ? "관리자 비밀번호가 맞지 않아요." : "서버에 ADMIN_KEY가 설정되지 않았어요." });
  }
  adminFails.delete(req.ip);
  next();
}

app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
  const now = Date.now();
  const todayKey = kstDay(now);
  // 오늘 포함 days일 (한국 시간 기준)
  const startKey = kstDay(now - (days - 1) * 86400000);
  const since = new Date(`${startKey}T00:00:00+09:00`).getTime();
  const rows = q.visitsSince.all(since);

  const daily = {};
  for (let i = 0; i < days; i++) daily[kstDay(since + i * 86400000 + 3600000)] = { views: 0, visitors: new Set(), signups: 0 };
  const sources = {};
  const referrers = {};
  const allVisitors = new Set();
  for (const r of rows) {
    const d = daily[kstDay(r.ts)];
    if (d) { d.views++; d.visitors.add(r.vid); }
    allVisitors.add(r.vid);
    sources[r.source] = sources[r.source] || { views: 0, visitors: new Set() };
    sources[r.source].views++;
    sources[r.source].visitors.add(r.vid);
    if (r.referrer) {
      try {
        const u = new URL(r.referrer);
        if (u.hostname !== req.hostname) {
          const k = u.hostname.replace(/^www\./, "") + u.pathname.slice(0, 40);
          referrers[k] = (referrers[k] || 0) + 1;
        }
      } catch {}
    }
  }
  for (const sgn of q.signupsSince.all(since)) {
    const d = daily[kstDay(sgn.created_at)];
    if (d) d.signups++;
  }
  const today = daily[todayKey];
  res.json({
    days,
    today: { views: today.views, visitors: today.visitors.size, signups: today.signups },
    total: {
      views: rows.length,
      visitors: allVisitors.size,
      signups: Object.values(daily).reduce((n, d) => n + d.signups, 0),
    },
    daily: Object.entries(daily).map(([date, d]) => ({ date, views: d.views, visitors: d.visitors.size, signups: d.signups })),
    sources: Object.entries(sources)
      .map(([name, v]) => ({ name, views: v.views, visitors: v.visitors.size }))
      .sort((a, b) => b.visitors - a.visitors),
    referrers: Object.entries(referrers).map(([url, n]) => ({ url, n })).sort((a, b) => b.n - a.n).slice(0, 15),
  });
});

function readSlotBody(body) {
  const date = String(body.date || "");
  const start = String(body.start || "");
  const end = String(body.end || "");
  const place = String(body.place || "").trim().slice(0, 100);
  const capacity = Math.round(Number(body.capacity));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date).getTime())) return { error: "날짜를 확인해 주세요." };
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start >= end) return { error: "시작·종료 시간을 확인해 주세요." };
  if (!place) return { error: "장소를 입력해 주세요." };
  if (!(capacity >= 1 && capacity <= 100)) return { error: "정원은 1~100명 사이로 입력해 주세요." };
  return { slot: { date, start, end, place, capacity, open: body.open === false ? 0 : 1 } };
}

function slotsWithCounts() {
  const counts = Object.fromEntries(q.countBySlot.all().map((r) => [r.slot_id, r.n]));
  return loadSchedule().map((s) => ({ ...s, label: formatSlot(s), taken: counts[s.id] || 0, past: startsAt(s) <= Date.now() }));
}

app.get("/api/admin/sms-balance", requireAdmin, async (req, res) => {
  if (!smsConfigured()) return res.json({ configured: false, notifyTo: ADMIN_PHONES.length });
  try {
    res.json({ configured: true, notifyTo: ADMIN_PHONES.length, ...(await getBalance()) });
  } catch (e) {
    res.status(502).json({ error: "솔라피 잔액을 불러오지 못했어요." });
  }
});

app.get("/api/admin/slots", requireAdmin, (req, res) => {
  res.json({ slots: slotsWithCounts() });
});

app.post("/api/admin/slots", requireAdmin, (req, res) => {
  const { slot, error } = readSlotBody(req.body);
  if (error) return res.status(400).json({ error });
  slot.id = `${slot.date}-${slot.start.replace(":", "")}-${crypto.randomBytes(2).toString("hex")}`;
  q.insertSlot.run(slot);
  res.json({ success: true });
});

app.put("/api/admin/slots/:id", requireAdmin, (req, res) => {
  if (!q.getSlot.get(req.params.id)) return res.status(404).json({ error: "없는 일정이에요." });
  const { slot, error } = readSlotBody(req.body);
  if (error) return res.status(400).json({ error });
  const taken = q.countSlot.get(req.params.id).n;
  if (slot.capacity < taken) return res.status(400).json({ error: `이미 ${taken}명이 신청해서 정원을 그보다 줄일 수 없어요.` });
  q.updateSlot.run({ ...slot, id: req.params.id });
  res.json({ success: true });
});

app.delete("/api/admin/slots/:id", requireAdmin, (req, res) => {
  const taken = q.countSlot.get(req.params.id).n;
  if (taken > 0) return res.status(400).json({ error: `신청자 ${taken}명이 있어 삭제할 수 없어요. 신청 받기를 끄거나 신청자를 먼저 취소해 주세요.` });
  q.deleteSlot.run(req.params.id);
  res.json({ success: true });
});

// 이미 신청한 사람들에게 수강 안내 링크를 다시 보냅니다.
app.post("/api/admin/slots/:id/notify", requireAdmin, async (req, res) => {
  const slot = q.getSlot.get(req.params.id);
  if (!slot) return res.status(404).json({ error: "없는 일정이에요." });
  if (!smsConfigured()) return res.status(503).json({ error: "문자 발송 설정이 안 되어 있어요." });
  const people = q.listSignups.all().filter((r) => r.slot_id === slot.id);
  const text = `[바이브코딩] ${shortSlot(slot)} 클래스 안내: ${INFO_URL}`;
  let sent = 0;
  for (const p of people) {
    try { await sendSms(p.phone, text); sent++; } catch {}
  }
  res.json({ success: true, sent, total: people.length });
});

app.get("/api/admin/signups", requireAdmin, (req, res) => {
  res.json({ slots: slotsWithCounts(), signups: q.listSignups.all() });
});

app.delete("/api/admin/signups/:id", requireAdmin, (req, res) => {
  q.deleteSignup.run(Number(req.params.id));
  res.json({ success: true });
});

app.get("/api/admin/storage", requireAdmin, (req, res) => {
  res.json({ dataDir: DATA_DIR, persistent: !DATA_NOT_PERSISTENT });
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  console.log(`데이터 저장 위치: ${DATA_DIR}`);
  if (DATA_NOT_PERSISTENT) console.warn("⚠️ Railway 볼륨이 없어 재배포하면 일정·신청·통계 데이터가 지워집니다.");
  if (!smsConfigured()) console.log("솔라피 키가 없어 개발 모드로 인증번호를 콘솔에 출력합니다.");
});
