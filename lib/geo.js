// 방문자 IP로 대략적인 지역(시·도, 시·군·구)을 찾습니다.
// 외부 서비스에 IP를 보내지 않도록 서버 안에 들어 있는 지역 DB(geoip-lite)를 씁니다.
// 휴대폰 데이터(LTE·5G)로 들어오면 통신사 본사 위치(대부분 서울)로 잡혀서 실제 위치와 다를 수 있어요.
let geoip = null;
try { geoip = require("geoip-lite"); } catch (e) { console.error("geoip-lite 로드 실패", e.message); }

const KR_REGIONS = {
  "11": "서울", "26": "부산", "27": "대구", "28": "인천", "29": "광주", "30": "대전", "31": "울산",
  "50": "세종", "41": "경기", "42": "강원", "51": "강원", "43": "충북", "44": "충남",
  "45": "전북", "52": "전북", "46": "전남", "47": "경북", "48": "경남", "49": "제주",
};

function cleanIp(ip) {
  return String(ip || "").trim().replace(/^::ffff:/, "");
}

// 화면에 보여줄 때는 IP 끝자리를 가립니다. (예: 211.234.10.*)
function maskIp(ip) {
  ip = cleanIp(ip);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.replace(/\.\d+$/, ".*");
  if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":") + ":*";
  return "";
}

// { region: "서울", city: "Seocho-gu" } 처럼 돌려줍니다. 모르면 region은 "알 수 없음".
function lookupRegion(ip) {
  ip = cleanIp(ip);
  const g = geoip && ip ? geoip.lookup(ip) : null;
  if (!g || !g.country) return { region: "알 수 없음", city: "" };
  if (g.country !== "KR") return { region: `해외(${g.country})`, city: g.city || "" };
  return { region: KR_REGIONS[g.region] || "한국(지역 모름)", city: g.city || "" };
}

// 나라 코드(예: "KR", "US")를 돌려줍니다. DB에 없는 주소(사설망·내부 주소 포함)는 "".
function countryOf(ip) {
  ip = cleanIp(ip);
  const g = geoip && ip ? geoip.lookup(ip) : null;
  return (g && g.country) || "";
}

module.exports = { lookupRegion, maskIp, countryOf };
