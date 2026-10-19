const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const Database = require("better-sqlite3");
const { sendSms, smsConfigured } = require("./lib/sms");

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ADMIN_KEY = process.env.ADMIN_KEY || "";

const CODE_TTL_MS = 3 * 60 * 1000; // 인증번호 유효시간 3분
const RESEND_COOLDOWN_MS = 60 * 1000; // 같은 번호 재발송 대기 1분
const MAX_SENDS_PER_HOUR = 5; // 번호당 시간당 발송 횟수
const MAX_SENDS_PER_IP_HOUR = 20; // IP당 시간당 발송 횟수
const MAX_VERIFY_ATTEMPTS = 5;
const TOKEN_TTL_MS = 30 * 60 * 1000; // 인증 후 신청까지 30분

// ── 일정 ──────────────────────────────────────────────
// 일정은 schedule.json에서 관리합니다. capacity 기본값은 6명.
function loadSchedule() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "schedule.json"), "utf8"));
  return raw.map((s) => ({ capacity: 6, ...s }));
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
  CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

const q = {
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
  const origin = `${req.protocol}://${req.get("host")}`;
  res.type("html").send(indexHtml.replaceAll('content="/og.png"', `content="${origin}/og.png"`));
});
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/slots", (req, res) => {
  const counts = Object.fromEntries(q.countBySlot.all().map((r) => [r.slot_id, r.n]));
  const now = Date.now();
  const slots = loadSchedule()
    .filter((s) => startsAt(s) > now - 24 * 60 * 60 * 1000)
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
    await sendSms(phone, `[바이브코딩 클래스] 인증번호 ${code} (3분 안에 입력해 주세요)`);
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
  if (!slot) return res.status(400).json({ error: "일정을 다시 선택해 주세요." });
  if (startsAt(slot) <= Date.now()) return res.status(400).json({ error: "이미 지난 일정이에요." });

  const result = applyTx(slot, name, t.phone, memo);
  if (result === "duplicate") return res.status(409).json({ error: "이 번호로 이미 신청한 일정이에요." });
  if (result === "full") return res.status(409).json({ error: "아쉽게도 방금 마감됐어요. 다른 일정을 선택해 주세요." });

  q.deleteToken.run(t.token);

  if (smsConfigured()) {
    sendSms(t.phone, `[바이브코딩 클래스] ${name}님, ${formatSlot(slot)} 클래스 신청이 완료됐어요. 장소: ${slot.place}`)
      .catch(() => {}); // 확인 문자는 실패해도 신청은 유지
  }
  res.json({ success: true, slot: { ...slot, label: formatSlot(slot) } });
});

// ── 관리자: 신청자 명단 ──────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.get("x-admin-key") || "";
  if (!ADMIN_KEY || key.length !== ADMIN_KEY.length ||
      !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY))) {
    return res.status(401).json({ error: "관리자 비밀번호가 맞지 않아요." });
  }
  next();
}

app.get("/api/admin/signups", requireAdmin, (req, res) => {
  const slots = loadSchedule().map((s) => ({ ...s, label: formatSlot(s) }));
  res.json({ slots, signups: q.listSignups.all() });
});

app.delete("/api/admin/signups/:id", requireAdmin, (req, res) => {
  q.deleteSignup.run(Number(req.params.id));
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  if (!smsConfigured()) console.log("솔라피 키가 없어 개발 모드로 인증번호를 콘솔에 출력합니다.");
});
