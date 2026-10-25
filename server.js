const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const Database = require("better-sqlite3");
const { sendSms, smsConfigured, getBalance } = require("./lib/sms");

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production";
// 데이터 저장 위치. Railway에 볼륨을 붙이면 RAILWAY_VOLUME_MOUNT_PATH가 자동으로 생기고, 그 안에 저장해야 재배포 후에도 남습니다.
// DATA_DIR이 볼륨 밖을 가리키면(예: 볼륨은 /app/data인데 DATA_DIR=/data) 재배포 때 지워지므로, 그럴 땐 DATA_DIR을 무시하고 볼륨을 씁니다.
const VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH) : "";
const isInside = (dir, root) => dir === root || dir.startsWith(root + path.sep);
const requestedDir = process.env.DATA_DIR ? path.resolve(__dirname, process.env.DATA_DIR) : "";
const DATA_DIR = VOLUME_PATH
  ? (requestedDir && isInside(requestedDir, VOLUME_PATH) ? requestedDir : VOLUME_PATH)
  : (requestedDir || path.join(__dirname, "data"));
const IGNORED_DATA_DIR = Boolean(VOLUME_PATH && requestedDir && !isInside(requestedDir, VOLUME_PATH));
// Railway에서 볼륨 없이 돌고 있으면 재배포 때 데이터가 지워집니다. 관리자 화면에 경고를 띄웁니다.
const DATA_NOT_PERSISTENT = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) && !VOLUME_PATH;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
// 검색엔진용 대표 주소와 사이트 소유 확인 값 (구글 서치 콘솔, 네이버 서치어드바이저에서 받은 content 값)
// 배포 구분용 (서버가 시작된 시각). 재배포가 반영됐는지 확인할 때 씁니다.
const BUILD_ID = process.env.RAILWAY_DEPLOYMENT_ID || new Date().toISOString();
const SITE_URL = (process.env.SITE_URL || "https://aieo.kr").replace(/\/$/, "");
const GOOGLE_SITE_VERIFICATION = process.env.GOOGLE_SITE_VERIFICATION || "";
const NAVER_SITE_VERIFICATION = process.env.NAVER_SITE_VERIFICATION || "";
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
    capacity INTEGER NOT NULL DEFAULT 5,
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
      q.insertSlot.run({ capacity: 5, ...s, open: 1 });
    }
  }
}

// 1회성 변경: 회차당 정원을 6명에서 5명으로 줄입니다. 이미 6명이 신청한 일정은 그대로 둡니다.
if (db.pragma("user_version", { simple: true }) < 1) {
  db.prepare("UPDATE slots SET capacity = 5 WHERE capacity = 6 AND (SELECT COUNT(*) FROM signups WHERE slot_id = slots.id) <= 5").run();
  db.pragma("user_version = 1");
}

// 정원 확인과 저장을 한 트랜잭션으로 묶어 동시에 신청해도 정원을 넘지 않게 합니다.
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
// Railway 기본 주소로 들어오면 대표 도메인으로 보냅니다(검색엔진에 주소가 둘로 나뉘지 않게). API는 그대로 둡니다.
app.use((req, res, next) => {
  if (req.method === "GET" && /\.up\.railway\.app$/.test(req.hostname) && !req.path.startsWith("/api/")) {
    return res.redirect(301, SITE_URL + req.originalUrl);
  }
  next();
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /admin.html\nDisallow: /api/\nDisallow: /info\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
});

app.get("/sitemap.xml", (req, res) => {
  const lastmod = new Date(fs.statSync(path.join(__dirname, "public", "index.html")).mtime).toISOString().slice(0, 10);
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_URL}/</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>
`);
});

const htmlEsc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// 검색엔진이 자바스크립트를 실행하지 않아도 일정이 보이도록 서버에서 미리 그려 둡니다.
function openUpcomingSlots() {
  const now = Date.now();
  return loadSchedule().filter((s) => s.open && startsAt(s) > now);
}
function slotsSsr() {
  const slots = openUpcomingSlots();
  if (!slots.length) return '<p class="muted">지금은 열린 일정이 없어요. 곧 다음 일정을 공지할게요.</p>';
  return "<ul class=\"muted\">" + slots.map((s) => `<li>${htmlEsc(formatSlot(s))} · ${htmlEsc(s.place)} · 정원 ${s.capacity}명</li>`).join("") + "</ul>";
}
// 구글 검색 결과에 강의 정보가 나오도록 하는 구조화 데이터(Course)
function courseJsonLd() {
  const data = {
    "@context": "https://schema.org",
    "@type": "Course",
    name: "바이브 코딩 입문 클래스: 클로드 코드(Claude Code)로 2시간 30분 만에 첫 서비스 만들기",
    description: "코딩을 몰라도 클로드 코드와 대화하며 나만의 웹페이지를 만들고 배포까지 해보는 강남 오프라인 2시간 30분 입문 강의.",
    inLanguage: "ko",
    url: SITE_URL + "/",
    image: SITE_URL + "/og.png",
    provider: { "@type": "Person", name: "Bill", jobTitle: "IT 회사 15년 차 서비스 기획자", email: "bill@neonex.team" },
    offers: { "@type": "Offer", category: "Paid", price: 30000, priceCurrency: "KRW", availability: "https://schema.org/InStock", url: SITE_URL + "/#apply" },
    hasCourseInstance: openUpcomingSlots().map((s) => ({
      "@type": "CourseInstance",
      courseMode: "Onsite",
      startDate: `${s.date}T${s.start}:00+09:00`,
      endDate: `${s.date}T${s.end}:00+09:00`,
      location: { "@type": "Place", name: s.place, address: { "@type": "PostalAddress", addressLocality: "강남구", addressRegion: "서울", addressCountry: "KR" } },
      instructor: { "@type": "Person", name: "Bill" },
    })),
  };
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

// 카카오톡·페이스북 등은 미리보기 이미지 주소를 절대 경로로 요구해서, 접속한 도메인을 붙여 내려줍니다.
const indexHtml = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
app.get(["/", "/index.html"], (req, res) => {
  try { trackVisit(req, res); } catch (e) { console.error("visit log error", e); }
  const origin = `${req.protocol}://${req.get("host")}`;
  const verify =
    (GOOGLE_SITE_VERIFICATION ? `<meta name="google-site-verification" content="${htmlEsc(GOOGLE_SITE_VERIFICATION)}">\n` : "") +
    (NAVER_SITE_VERIFICATION ? `<meta name="naver-site-verification" content="${htmlEsc(NAVER_SITE_VERIFICATION)}">\n` : "");
  res.type("html").send(indexHtml
    .replaceAll('content="/og.png"', `content="${origin}/og.png"`)
    .replace("<!--SEO_EXTRA-->", verify + courseJsonLd())
    .replace("<!--SLOTS_SSR-->", slotsSsr())
    .replace("</head>", `<meta name="build-id" content="${BUILD_ID}">\n</head>`));
});
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] })); // /info → info.html

// 수강 안내 페이지의 장소 미리보기: 네이버 지도 공유 링크의 og 태그(제목·이미지)를 읽어 하루 동안 캐시합니다.
const PLACE_URL = process.env.PLACE_URL || "https://naver.me/Fk76MHgd";
const PLACE_ZOOM_OUT = Number(process.env.PLACE_ZOOM_OUT || 3); // 미리보기 지도를 몇 단계 더 넓게 보여줄지
let placeCache = { at: 0, data: null };
// 네이버 정적 지도 이미지 주소의 확대 단계(level/zoom)를 낮춰 더 넓은 범위가 보이게 합니다.
function zoomOutMap(image, steps) {
  try {
    const u = new URL(image);
    let changed = false;
    for (const key of ["level", "zoom", "z"]) {
      const v = Number(u.searchParams.get(key));
      if (u.searchParams.has(key) && Number.isFinite(v)) { u.searchParams.set(key, String(Math.max(1, v - steps))); changed = true; }
    }
    // search.pstatic.net/common/?src=... 처럼 다른 주소로 감싼 경우 안쪽 주소도 바꿉니다.
    const inner = u.searchParams.get("src");
    if (inner && /^https?:\/\//.test(inner)) {
      const z = zoomOutMap(inner, steps);
      if (z !== inner) { u.searchParams.set("src", z); changed = true; }
    }
    return changed ? u.toString() : image;
  } catch { return image; }
}
// 미리보기 지도 주소나 페이지 안에서 장소 좌표(경도·위도)를 찾습니다. 찾으면 안내 페이지가 지하철역까지 보이는 넓은 지도를 직접 그립니다.
function findCoords(...texts) {
  if (process.env.PLACE_LAT && process.env.PLACE_LNG) return { lat: Number(process.env.PLACE_LAT), lng: Number(process.env.PLACE_LNG) };
  for (const raw of texts) {
    let t = String(raw || "");
    for (let i = 0; i < 3; i++) { try { t = decodeURIComponent(t); } catch { break; } }
    const m = t.match(/(12[4-9]\.\d{3,})[\s,:/]+(3[3-8]\.\d{3,})/) ||
      t.match(/"x"\s*:\s*"?(12[4-9]\.\d{3,})"?\s*,\s*"y"\s*:\s*"?(3[3-8]\.\d{3,})/);
    if (m) return { lng: Number(m[1]), lat: Number(m[2]) };
  }
  return null;
}
function metaContent(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, "i");
  const tag = (html.match(re) || [])[0];
  const m = tag && tag.match(/content=["']([^"']*)["']/i);
  return m ? m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : "";
}
app.get("/api/place-preview", async (req, res) => {
  if (placeCache.data && Date.now() - placeCache.at < 24 * 3600 * 1000) return res.json(placeCache.data);
  try {
    const r = await fetch(PLACE_URL, {
      redirect: "follow",
      headers: { "User-Agent": "facebookexternalhit/1.1", "Accept-Language": "ko-KR,ko;q=0.9" },
      signal: AbortSignal.timeout(6000),
    });
    const html = (await r.text()).slice(0, 300000);
    let image = metaContent(html, "og:image");
    if (image.startsWith("//")) image = "https:" + image;
    const coords = findCoords(image, r.url, html);
    image = zoomOutMap(image, PLACE_ZOOM_OUT);
    const data = {
      url: PLACE_URL,
      title: metaContent(html, "og:title"),
      description: metaContent(html, "og:description"),
      image: /^https:\/\//.test(image) ? image : "",
      lat: coords ? coords.lat : null,
      lng: coords ? coords.lng : null,
    };
    placeCache = { at: Date.now(), data };
    res.json(data);
  } catch (e) {
    console.error("place preview error", e.message);
    const c = findCoords();
    res.json({ url: PLACE_URL, title: "", description: "", image: "", lat: c ? c.lat : null, lng: c ? c.lng : null });
  }
});

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
    // 전화번호를 마지막 줄에 따로 두어, 문자앱이 번호와 날짜를 하나의 링크로 묶지 않게 합니다.
    const note = `[새신청] ${name.slice(0, 5)} ${taken}/${slot.capacity}명\n${shortSlot(slot)}\n${fmtPhone}`;
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

// 다가올 일정은 신청자가 있으면 지울 수 없고, 이미 지난 일정은 신청자 기록과 함께 지웁니다.
const deleteSlotWithSignups = db.transaction((id) => {
  db.prepare("DELETE FROM signups WHERE slot_id = ?").run(id);
  q.deleteSlot.run(id);
});
app.delete("/api/admin/slots/:id", requireAdmin, (req, res) => {
  const slot = q.getSlot.get(req.params.id);
  if (!slot) return res.status(404).json({ error: "없는 일정이에요." });
  const taken = q.countSlot.get(slot.id).n;
  const past = startsAt(slot) <= Date.now();
  if (taken > 0 && !past) return res.status(400).json({ error: `신청자 ${taken}명이 있어 삭제할 수 없어요. 신청 받기를 끄거나 신청자를 먼저 취소해 주세요.` });
  deleteSlotWithSignups(slot.id);
  res.json({ success: true, removedSignups: taken });
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

// 관리자가 신청자를 직접 추가 (전화·문자로 받은 신청이나 복구용). 정원 검사는 그대로 합니다.
app.post("/api/admin/signups", requireAdmin, (req, res) => {
  const slot = q.getSlot.get(String(req.body.slotId || ""));
  if (!slot) return res.status(400).json({ error: "일정을 선택해 주세요." });
  const name = String(req.body.name || "").trim().slice(0, 30);
  const phone = normalizePhone(req.body.phone);
  const memo = String(req.body.memo || "").trim().slice(0, 300);
  if (!name) return res.status(400).json({ error: "이름을 입력해 주세요." });
  if (!phone) return res.status(400).json({ error: "휴대폰 번호를 확인해 주세요." });
  const result = applyTx(slot, name, phone, memo);
  if (result === "duplicate") return res.status(409).json({ error: "이 번호는 이미 이 일정에 신청돼 있어요." });
  if (result === "full") return res.status(409).json({ error: "정원이 찼어요. 정원을 늘린 뒤 추가해 주세요." });
  res.json({ success: true });
});

// 일정과 신청자 전체를 JSON으로 내려받기 (백업용)
app.get("/api/admin/backup", requireAdmin, (req, res) => {
  res.set("Content-Disposition", `attachment; filename="vibe-class-backup-${kstDay(Date.now())}.json"`);
  res.json({ exportedAt: new Date().toISOString(), slots: q.allSlots.all(), signups: q.listSignups.all() });
});

app.delete("/api/admin/signups/:id", requireAdmin, (req, res) => {
  q.deleteSignup.run(Number(req.params.id));
  res.json({ success: true });
});

app.get("/api/admin/storage", requireAdmin, (req, res) => {
  res.json({ dataDir: DATA_DIR, volume: VOLUME_PATH, ignoredDataDir: IGNORED_DATA_DIR ? requestedDir : "", persistent: !DATA_NOT_PERSISTENT });
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  console.log(`데이터 저장 위치: ${DATA_DIR}` + (VOLUME_PATH ? ` (볼륨: ${VOLUME_PATH})` : " (볼륨 없음)"));
  if (IGNORED_DATA_DIR) console.warn(`⚠️ DATA_DIR(${requestedDir})이 볼륨 밖이라 무시하고 볼륨에 저장합니다. Railway Variables에서 DATA_DIR을 지워 주세요.`);
  if (DATA_NOT_PERSISTENT) console.warn("⚠️ Railway 볼륨이 없어 재배포하면 일정·신청·통계 데이터가 지워집니다.");
  if (!smsConfigured()) console.log("솔라피 키가 없어 개발 모드로 인증번호를 콘솔에 출력합니다.");
});
