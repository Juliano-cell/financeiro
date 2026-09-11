import { env } from "cloudflare:workers";

export type TelegramButton = { text: string; callback_data: string };

export async function sendTelegramMessage(chatId: string, text: string, buttons?: TelegramButton[][]) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN não configurado.");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {}) }) });
  if (!response.ok) throw new Error(`Telegram respondeu ${response.status}.`);
}

export const formatBrl = (cents: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
