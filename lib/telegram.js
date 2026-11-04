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

// 봇에게 온 메시지를 받아 처리합니다 (getUpdates 롱 폴링).
// 웹훅과 달리 따로 주소를 등록할 필요가 없어서, 토큰과 채팅 ID만 있으면 바로 동작해요.
// 설정된 관리자 채팅(TELEGRAM_CHAT_ID)에서 온 메시지만 onMessage로 넘기고, 나머지는 무시합니다.
function startTelegramCommands(onMessage) {
  if (!telegramConfigured()) return;
  const base = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
  const adminChat = String(process.env.TELEGRAM_CHAT_ID).trim();
  const startedAt = Math.floor(Date.now() / 1000);
  let offset = 0;
  let delay = 0;
  const loop = async () => {
    try {
      const res = await fetch(`${base}/getUpdates?timeout=50&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`, {
        signal: AbortSignal.timeout(60000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        // 409: 재배포 중 예전 서버가 아직 받고 있거나, 봇에 웹훅이 걸려 있을 때. 잠깐 쉬었다 다시 시도해요.
        console.error("Telegram getUpdates error:", res.status, data.description || "");
        delay = Math.min(60000, (delay || 2000) * 2);
      } else {
        delay = 0;
        for (const u of data.result) {
          offset = u.update_id + 1;
          const m = u.message;
          if (!m || typeof m.text !== "string") continue;
          if (String(m.chat.id) !== adminChat) continue;
          if (m.date < startedAt - 120) continue; // 서버가 꺼져 있던 동안 쌓인 오래된 메시지엔 답하지 않아요
          try {
            await onMessage(m.text.trim());
          } catch (e) {
            console.error("Telegram command error:", e.message);
          }
        }
      }
    } catch (e) {
      if (e.name !== "TimeoutError") console.error("Telegram getUpdates error:", e.message);
      delay = Math.min(60000, (delay || 2000) * 2);
    }
    setTimeout(loop, delay);
  };
  loop();
}

module.exports = { sendTelegram, telegramConfigured, startTelegramCommands };
