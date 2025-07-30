import * as functions from "firebase-functions";
import {accessSecret} from "./secretManager";
import axios from "axios";

/**
 * Wysyła powiadomienie do administratora o błędzie krytycznym na Telegrama.
 * @param {string} title Tytuł powiadomienia.
 * @param {string} message Treść powiadomienia.
 */
export async function sendAdminNotification(title: string, message: string): Promise<void> {
  try {
    const botToken = await accessSecret("telegram-bot-token");
    const chatId = await accessSecret("telegram-chat-id");

    if (!botToken || !chatId) {
      functions.logger.error("Brak tokenu bota lub chat ID w Secret Managerze.");
      return;
    }

    const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

    // Formatujemy wiadomość używając składni Markdown Telegrama
    const text = `🚨 *ALERT APLIKACJI* 🚨\n\n*${title}*\n\n\`\`\`\n${message}\n\`\`\``;

    await axios.post(telegramApiUrl, {
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
    });

    functions.logger.info("✅ Pomyślnie wysłano powiadomienie na Telegrama.");
  } catch (error) {
    functions.logger.error(
      "❌ Błąd krytyczny podczas wysyłania powiadomienia na Telegrama:",
      error
    );
  }
}

// Definicja, jak tekst z ustawień mapuje się na minuty
export const NOTIFICATION_WINDOWS: {[key: string]: number} = {
  "15 minut": 15,
  "30 minut": 30,
  "1 godzina": 60,
  "2 godziny": 120,
};
