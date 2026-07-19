// Telegram push notifications — for the moments that can't wait for the
// dashboard: a lead replying to outreach (reply speed is the close), a
// high-urgency email, the daily outreach summary. Direct Bot API, no
// dependencies; silently a no-op until TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID are configured, and a Telegram outage must never break
// the pipeline that calls it.
const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT = () => process.env.TELEGRAM_CHAT_ID ?? "";

export const telegramConfigured = (): boolean => Boolean(TOKEN() && CHAT());

export async function notifyTelegram(text: string): Promise<boolean> {
  if (!telegramConfigured()) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT(), text: text.slice(0, 3900), disable_web_page_preview: true }),
    });
    if (!res.ok) console.error(`[notify] telegram ${res.status}: ${(await res.text()).slice(0, 120)}`);
    return res.ok;
  } catch (e) {
    console.error("[notify] telegram failed:", e instanceof Error ? e.message : e);
    return false;
  }
}
