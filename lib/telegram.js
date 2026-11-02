// 텔레그램 봇으로 관리자에게 알림 보내기 (Bot API sendMessage)
// TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID 둘 중 하나라도 없으면 조용히 건너뜁니다.

function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

// 실패해도 예외를 던지지 않습니다. 텔레그램 문제로 신청이나 문자 발송이 막히면 안 되니까요.
async function sendTelegram(text) {
  if (!telegramConfigured()) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error("Telegram error:", res.status, err.description || "");
      return false;
    }
    return true;
  } catch (e) {
    console.error("Telegram error:", e.message); // 토큰이 담긴 URL은 남기지 않습니다
    return false;
  }
}

module.exports = { sendTelegram, telegramConfigured };
