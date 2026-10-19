// 솔라피 문자 발송 (solo 프로젝트의 lib/sms.ts와 같은 방식)
const crypto = require("crypto");

function makeAuthHeader(apiKey, apiSecret) {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString("hex");
  const signature = crypto.createHmac("sha256", apiSecret).update(date + salt).digest("hex");
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

function smsConfigured() {
  return Boolean(process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET && process.env.SOLAPI_SENDER);
}

// 단문(SMS)은 90바이트까지(한글 2바이트, 영문·숫자 1바이트). 넘으면 장문 요금이 붙어서 잘라서 보냅니다.
const SMS_MAX_BYTES = 90;
function smsBytes(str) {
  let n = 0;
  for (const ch of str) n += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  return n;
}
function fitSms(text) {
  let out = "", n = 0;
  for (const ch of text) {
    const b = ch.charCodeAt(0) > 0x7f ? 2 : 1;
    if (n + b > SMS_MAX_BYTES) break;
    out += ch; n += b;
  }
  return out;
}

async function sendSms(to, text) {
  text = fitSms(text);
  const res = await fetch("https://api.solapi.com/messages/v4/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: makeAuthHeader(process.env.SOLAPI_API_KEY, process.env.SOLAPI_API_SECRET),
    },
    body: JSON.stringify({
      message: { to: to.replace(/\D/g, ""), from: process.env.SOLAPI_SENDER.replace(/\D/g, ""), text, type: "SMS" },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("Solapi error:", err);
    throw new Error(err.errorMessage || "SMS 발송에 실패했습니다.");
  }
}

// 남은 잔액(원)과 포인트 조회 (solo 프로젝트의 getBalance와 같은 방식)
async function getBalance() {
  const res = await fetch("https://api.solapi.com/cash/v1/balance", {
    headers: { Authorization: makeAuthHeader(process.env.SOLAPI_API_KEY, process.env.SOLAPI_API_SECRET) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("Solapi balance error:", err);
    throw new Error(err.errorMessage || "잔액 조회에 실패했습니다.");
  }
  const data = await res.json();
  return { balance: data.balance ?? 0, point: data.point ?? 0 };
}

module.exports = { sendSms, smsConfigured, getBalance, smsBytes, fitSms };
