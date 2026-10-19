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

async function sendSms(to, text) {
  const res = await fetch("https://api.solapi.com/messages/v4/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: makeAuthHeader(process.env.SOLAPI_API_KEY, process.env.SOLAPI_API_SECRET),
    },
    body: JSON.stringify({
      message: { to: to.replace(/\D/g, ""), from: process.env.SOLAPI_SENDER.replace(/\D/g, ""), text },
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

module.exports = { sendSms, smsConfigured, getBalance };
